import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { ComponentType } from 'discord.js';
import { openTestDatabase } from '../db/index.js';
import {
  DEFAULT_SETTINGS,
  EMOJI_ADOPT_NAMES,
  EMOJI_FALLBACKS,
  EMOJI_LABELS,
  EMOJI_SLOTS,
  clearSettingsCache,
  getSettings,
  setByPath,
} from '../db/settings.js';
import { bar, scoreBand, timeline, trendLabel } from '../core/ui.js';
import { Ids, makeId, parseId } from '../core/ids.js';
import {
  COMMANDS,
  MODULES,
  allCommandNames,
  commandsFor,
  isModuleEnabled,
  moduleBlockedReason,
  resolveCommand,
  tierAllows,
  visibleCommands,
} from '../core/registry.js';
import { buildCommands } from '../core/commands.js';
import { GROUPS } from '../core/settingsUi.js';
import { DELEGATABLE_GROUPS, OWNER_ONLY_GROUPS } from '../core/permissions.js';

const GUILD = 'g1';

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
});

const EMPTY = '⬛';
const FILLED = /[🟩🟨🟧🟥]/u;
const segments = (rendered: string): string[] => [...rendered.match(/\p{Emoji_Presentation}/gu)!];

describe('progress bar', () => {
  it('always has ten segments', () => {
    for (const score of [0, 1, 37, 50, 99, 100]) {
      assert.equal(segments(bar(score)).length, 10, `score ${score}`);
    }
  });

  it('fills in proportion to the score', () => {
    const filledCount = (score: number) => segments(bar(score)).filter((part) => FILLED.test(part)).length;
    assert.equal(filledCount(0), 0);
    assert.equal(filledCount(50), 5);
    assert.equal(filledCount(70), 7);
    assert.equal(filledCount(100), 10);
  });

  it('never shows an empty bar for real activity, or a full one short of 100', () => {
    assert.ok(FILLED.test(bar(1)), 'a little is not nothing');
    assert.ok(bar(99).includes(EMPTY), '99 is not 100');
  });

  it('colours the bar by band, so it reads without the number', () => {
    assert.equal(scoreBand(85), 'high');
    assert.equal(scoreBand(55), 'good');
    assert.equal(scoreBand(25), 'low');
    assert.equal(scoreBand(5), 'none');
    assert.ok(bar(85).includes('🟩'));
    assert.ok(bar(25).includes('🟧'));
  });

  it('uses native emoji so it renders the same on desktop and mobile', () => {
    // No code span, no custom emoji ids — nothing that can fail to load.
    assert.ok(!bar(50).includes('`'));
    assert.ok(!bar(50).includes('<:'));
  });
});

describe('timeline', () => {
  it('shows quiet and untracked days differently', () => {
    const rendered = timeline(['active', 'idle', 'unknown']);
    const glyphs = new Set(rendered.replace(/[`\s]/g, '').split(''));
    assert.equal(glyphs.size, 3, 'three states must look like three things');
    assert.ok(rendered.includes('▰') && rendered.includes('▱') && rendered.includes('·'));
  });

  it('keeps one glyph per day, grouped into weeks', () => {
    const days = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 'active' : 'idle') as const);
    const rendered = timeline(days);
    assert.equal(rendered.replace(/[`\s]/g, '').length, 30, 'one mark per day');
    assert.equal(rendered.split(' ').length, 5, '7+7+7+7+2');
  });
});

describe('trend labels', () => {
  it('reads as words, not just arrows', () => {
    for (const direction of ['up', 'down', 'flat', 'none'] as const) {
      const label = trendLabel(direction);
      assert.ok(/[a-z]/i.test(label), `${direction} needs a word, not only a symbol`);
    }
  });
});

describe('custom ids', () => {
  it('round-trips and stays inside Discord’s limit', () => {
    const ids = [
      Ids.helpCategory(),
      Ids.settingsGroup('permissions'),
      Ids.settingsNumber('activity.messageCooldownSeconds'),
      Ids.activityAwaySet('123456789012345678', 30),
      Ids.purgeDecide('purge'),
      Ids.settingsEmoji('thumbsDown'),
    ];
    for (const id of ids) assert.ok(id.length <= 100, `${id} is ${id.length}`);

    const parsed = parseId(Ids.activityAwaySet('123456789012345678', 30))!;
    assert.equal(parsed.action, 'a.away2');
    assert.deepEqual(parsed.args, ['123456789012345678', '30']);
  });

  it('ignores ids that are not ours', () => {
    assert.equal(parseId('other:thing'), null);
  });

  it('refuses to build an oversized id instead of failing at Discord', () => {
    assert.throws(() => makeId('x', 'y'.repeat(200)));
  });
});

describe('the registry is the single source of truth', () => {
  it('registers exactly the commands it documents, aliases included', () => {
    const built = buildCommands().map((command) => command.toJSON());
    assert.deepEqual(built.map((command) => command.name).sort(), allCommandNames().sort());
    for (const command of built) {
      assert.ok(command.description.length > 0 && command.description.length <= 100, command.name);
    }
  });

  it('registers no name twice', () => {
    const names = allCommandNames();
    assert.equal(new Set(names).size, names.length, names.join(', '));
  });

  it('resolves every alias back to one handler', () => {
    for (const command of COMMANDS) {
      for (const alias of command.aliases ?? []) {
        assert.equal(resolveCommand(alias), command.name, alias);
      }
      assert.equal(resolveCommand(command.name), command.name);
    }
  });

  it('gives an alias the same options as the command it stands for', () => {
    const built = buildCommands().map((command) => command.toJSON());
    for (const command of COMMANDS) {
      const primary = built.find((entry) => entry.name === command.name)!;
      for (const alias of command.aliases ?? []) {
        const twin = built.find((entry) => entry.name === alias)!;
        assert.deepEqual(twin.options, primary.options, alias);
        assert.equal(twin.default_member_permissions, primary.default_member_permissions, alias);
      }
    }
  });

  it('knows nothing about names it was never given', () => {
    for (const unknown of ['', 'ALLIES ', 'activityy', 'purgeall', 'camelot']) {
      assert.equal(resolveCommand(unknown), null, unknown);
    }
  });

  it('offers a user option on the commands that can be aimed at someone', () => {
    const byName = new Map(COMMANDS.map((command) => [command.name, command]));
    assert.ok(byName.get('activity')?.userOption, 'activity takes a user');
    assert.ok(byName.get('purge')?.userOption, 'purge takes a user');
    // A user option on /settings or /help would mean nothing.
    assert.ok(!byName.get('settings')?.userOption);
    assert.ok(!byName.get('help')?.userOption);
  });

  it('keeps every user option optional, so the bare command still works', () => {
    for (const command of buildCommands().map((entry) => entry.toJSON())) {
      for (const option of command.options ?? []) {
        assert.equal((option as { required?: boolean }).required ?? false, false, command.name);
      }
    }
  });

  it('matches the four commands that were asked for', () => {
    assert.deepEqual(COMMANDS.map((command) => command.name).sort(), ['activity', 'help', 'purge', 'settings']);
  });

  it('keeps /allies as the short way to say /activity', () => {
    assert.deepEqual(COMMANDS.find((command) => command.name === 'activity')?.aliases, ['allies']);
  });

  it('has no leftover game panel command', () => {
    assert.ok(!COMMANDS.some((command) => command.name === 'camelot'));
  });

  it('points every command at a real module', () => {
    for (const command of COMMANDS) {
      assert.ok(
        MODULES.some((module) => module.key === command.module),
        `${command.name} points at a module that does not exist`,
      );
    }
  });

  it('hides commands whose module is off', () => {
    setByPath(GUILD, 'modules.activity', false);
    const settings = getSettings(GUILD);
    const names = visibleCommands(settings, 'owner').map((command) => command.name);
    assert.ok(!names.includes('activity'));
    assert.ok(names.includes('help'), 'core always survives');
  });

  it('turns off a module when its dependency goes off', () => {
    setByPath(GUILD, 'modules.activity', false);
    const settings = getSettings(GUILD);
    assert.equal(isModuleEnabled(settings, 'purge'), false, 'The Purge needs Activity');
    assert.match(moduleBlockedReason(settings, 'purge') ?? '', /Activity/);
    assert.ok(!visibleCommands(settings, 'owner').some((command) => command.name === 'purge'));
  });

  it('keeps Core on no matter what', () => {
    const settings = getSettings(GUILD);
    assert.equal(isModuleEnabled(settings, 'core'), true);
    assert.equal(MODULES.find((module) => module.key === 'core')?.togglable, false);
  });

  it('respects the tier ladder', () => {
    assert.equal(tierAllows('member', 'admin'), false);
    assert.equal(tierAllows('admin', 'admin'), true);
    assert.equal(tierAllows('owner', 'admin'), true);
    assert.equal(tierAllows('admin', 'owner'), false);
  });

  it('shows members only what they can use', () => {
    const settings = getSettings(GUILD);
    const names = visibleCommands(settings, 'member').map((command) => command.name);
    assert.deepEqual(names.sort(), ['activity', 'help']);
  });

  it('gives every module a settings group that exists', () => {
    for (const module of MODULES) {
      for (const group of module.settingsGroups) {
        assert.ok((GROUPS as readonly string[]).includes(group), `${module.key} -> ${group}`);
      }
    }
  });

  it('never lets admins delegate themselves owner powers', () => {
    for (const group of OWNER_ONLY_GROUPS) {
      assert.ok(
        !(DELEGATABLE_GROUPS as readonly string[]).includes(group),
        `${group} must not be delegatable`,
      );
    }
    assert.ok(OWNER_ONLY_GROUPS.includes('permissions'), 'permissions stays with the owner');
  });

  it('documents a command for every module that needs one', () => {
    assert.ok(commandsFor('clips').length === 0, 'clips runs automatically');
    assert.ok(commandsFor('activity').length > 0);
    assert.ok(commandsFor('purge').length > 0);
  });
});

describe('Components V2 payloads', () => {
  const CONTAINER = 17;

  it('defaults to unicode so a brand new server looks right immediately', () => {
    for (const slot of Object.keys(DEFAULT_SETTINGS.emojis) as (keyof typeof DEFAULT_SETTINGS.emojis)[]) {
      assert.ok(
        !DEFAULT_SETTINGS.emojis[slot].includes('<:'),
        `${slot} must not default to an emoji from one specific server`,
      );
    }
  });

  it('knows which server emoji names to adopt for each slot', () => {
    for (const slot of EMOJI_SLOTS) {
      assert.ok(EMOJI_ADOPT_NAMES[slot].length > 0, `${slot} has nothing to match on`);
      assert.ok(EMOJI_ADOPT_NAMES[slot].every((name) => name === name.toLowerCase()));
    }
    assert.ok(EMOJI_ADOPT_NAMES.thumbsUp.includes('z_thumbsup'));
  });

  it('builds a valid container with the shapes Discord expects', async () => {
    const { container, heading, divider, text, row, button } = await import('../core/ui.js');
    const built = container()
      .addTextDisplayComponents(heading('TITLE', 'caption'))
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text('body'))
      .addActionRowComponents(row(button('c:x', 'Go')))
      .toJSON();

    assert.equal(built.type, CONTAINER);
    const types = built.components.map((component) => component.type);
    assert.ok(types.includes(ComponentType.TextDisplay));
    assert.ok(types.includes(ComponentType.Separator));
    assert.ok(types.includes(ComponentType.ActionRow));
    // Discord allows at most five action rows in one message.
    assert.ok(types.filter((type) => type === ComponentType.ActionRow).length <= 5);
  });
});

describe('server emojis can replace any icon', () => {
  it('keeps every slot inside Discord’s select menu limit', () => {
    assert.ok(EMOJI_SLOTS.length <= 25, `${EMOJI_SLOTS.length} slots will not fit in one menu`);
  });

  it('gives every slot a unicode fallback and a label', () => {
    for (const slot of EMOJI_SLOTS) {
      assert.ok(EMOJI_FALLBACKS[slot], `${slot} has no fallback`);
      assert.ok(EMOJI_LABELS[slot]?.includes(' — '), `${slot} needs a "name — purpose" label`);
      assert.ok(EMOJI_ADOPT_NAMES[slot].length > 0, `${slot} cannot be auto-adopted`);
    }
  });

  it('renders a custom server emoji when the bot can reach it', async () => {
    const { emojiFor } = await import('../util/emoji.js');
    const custom = '<:Z_Sword:1572823986797154324>';
    const settings = { ...DEFAULT_SETTINGS, emojis: { ...DEFAULT_SETTINGS.emojis, voice: custom } };

    const reachable = { emojis: { cache: new Map([['1572823986797154324', { available: true }]]) } } as never;
    assert.equal(emojiFor(settings, 'voice', reachable), custom, 'uses the server emoji');

    const unreachable = { emojis: { cache: new Map() } } as never;
    assert.equal(emojiFor(settings, 'voice', unreachable), EMOJI_FALLBACKS.voice, 'falls back silently');
  });

  it('handles an animated server emoji', async () => {
    const { parseEmoji } = await import('../util/emoji.js');
    const parsed = parseEmoji('<a:Z_Spin:1572823986797154324>')!;
    assert.equal(parsed.animated, true);
    assert.equal(parsed.display, '<a:Z_Spin:1572823986797154324>');
    assert.equal(parsed.reactionKey, 'Z_Spin:1572823986797154324', 'buttons and reactions want name:id');
  });

  it('keeps the emoji screen inside Discord’s length limit', async () => {
    const { renderGroup } = await import('../core/settingsUi.js');
    const member = {
      guild: { id: GUILD, ownerId: GUILD, members: { me: null } },
      id: GUILD,
      roles: { cache: new Map() },
      permissions: { has: () => true },
    } as never;
    const built = renderGroup(member, 'emojis').toJSON();
    const total = JSON.stringify(built).length;
    assert.ok(total < 4000, `emoji screen is ${total} characters`);
  });
});

describe('animated server emojis stay animated', () => {
  const ANIMATED = '<a:Z_Clock:1572823986797154324>';
  const STATIC = '<:Z_Sword:1572823986797154324>';
  const reachable = { emojis: { cache: new Map([['1572823986797154324', { available: true }]]) } } as never;

  it('passes the animated flag to buttons instead of dropping it', async () => {
    const { componentEmojiFor } = await import('../util/emoji.js');
    const settings = { ...DEFAULT_SETTINGS, emojis: { ...DEFAULT_SETTINGS.emojis, quiet: ANIMATED } };
    const resolved = componentEmojiFor(settings, 'quiet', reachable);
    assert.deepEqual(resolved, { id: '1572823986797154324', name: 'Z_Clock', animated: true });
  });

  it('builds a button that Discord will actually animate', async () => {
    const { ButtonBuilder, ButtonStyle } = await import('discord.js');
    const { componentEmojiFor } = await import('../util/emoji.js');
    const settings = { ...DEFAULT_SETTINGS, emojis: { ...DEFAULT_SETTINGS.emojis, quiet: ANIMATED } };

    const built = new ButtonBuilder()
      .setCustomId('c:x')
      .setLabel('Go')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(componentEmojiFor(settings, 'quiet', reachable))
      .toJSON();

    assert.equal((built.emoji as { animated?: boolean }).animated, true);
  });

  it('marks a static emoji as static', async () => {
    const { componentEmojiFor } = await import('../util/emoji.js');
    const settings = { ...DEFAULT_SETTINGS, emojis: { ...DEFAULT_SETTINGS.emojis, sword: STATIC } };
    assert.deepEqual(componentEmojiFor(settings, 'sword', reachable), {
      id: '1572823986797154324',
      name: 'Z_Sword',
      animated: false,
    });
  });

  it('still falls back to unicode when the emoji is out of reach', async () => {
    const { componentEmojiFor } = await import('../util/emoji.js');
    const settings = { ...DEFAULT_SETTINGS, emojis: { ...DEFAULT_SETTINGS.emojis, quiet: ANIMATED } };
    const gone = { emojis: { cache: new Map() } } as never;
    assert.equal(componentEmojiFor(settings, 'quiet', gone), EMOJI_FALLBACKS.quiet);
  });

  it('reactions still get the bare name:id Discord expects', async () => {
    const { emojiKeyFor } = await import('../util/emoji.js');
    const settings = { ...DEFAULT_SETTINGS, emojis: { ...DEFAULT_SETTINGS.emojis, thumbsUp: ANIMATED } };
    assert.equal(emojiKeyFor(settings, 'thumbsUp', reachable), 'Z_Clock:1572823986797154324');
  });
});
