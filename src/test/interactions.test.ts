import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { openTestDatabase, getDb } from '../db/index.js';
import { clearSettingsCache, DEFAULT_SETTINGS } from '../db/settings.js';
import { Ids, makeId, parseId } from '../interactions/ids.js';
import { isSendable } from '../ui/payload.js';
import { parseEmoji } from '../util/emoji.js';
import { NO_MENTIONS, onlyUser } from '../util/mentions.js';
import { registerJob, runDueJobs, schedule } from '../scheduler.js';
import { renderGameStep, renderTimeStep } from '../interactions/startFlow.js';
import { CATEGORIES, CUSTOM_CATEGORIES, fieldsFor } from '../commands/fields.js';
import { renderCategory, renderFieldEditor, renderSettingsHome, renderSetup } from '../ui/settingsUi.js';
import { renderGamesHome } from '../ui/gamesUi.js';
import { renderEmojiHome } from '../ui/emojiUi.js';

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
});

describe('custom ids', () => {
  it('round-trips arguments', () => {
    const parsed = parseId(Ids.pickTime('rivals', 30))!;
    assert.equal(parsed.action, 'pick.time');
    assert.deepEqual(parsed.args, ['rivals', '30']);
  });

  it('carries the game id, so renaming a game never breaks a live button', () => {
    const parsed = parseId(Ids.pickTime('tom-clancy-siege', 15))!;
    assert.deepEqual(parsed.args, ['tom-clancy-siege', '15']);
  });

  it('stays inside Discord\'s 100-character limit', () => {
    for (const id of [
      Ids.panelStart(),
      Ids.sessionJoin(999_999),
      Ids.settingsModal('media.warning.deleteAfterSeconds'),
      Ids.settingsChannel('voice.eligible'),
      Ids.pickTime('a'.repeat(16), 30),
      Ids.gamesEditModal('a'.repeat(16)),
      Ids.emojiModal('thumbsDown'),
    ]) {
      assert.ok(id.length <= 100, `${id} is ${id.length} chars`);
    }
  });

  it('ignores ids that are not ours', () => {
    assert.equal(parseId('someoneelse:thing'), null);
  });

  it('refuses to build an oversized id rather than failing at Discord', () => {
    assert.throws(() => makeId('pick.time', 'G'.repeat(200), 30));
  });
});

describe('emoji handling (acceptance test 5)', () => {
  it('reads unicode, static and animated custom emojis', () => {
    assert.equal(parseEmoji('👍')!.reactionKey, '👍');
    const custom = parseEmoji('<:pog:123456789012345678>')!;
    assert.equal(custom.reactionKey, 'pog:123456789012345678');
    assert.equal(custom.display, '<:pog:123456789012345678>');
    const animated = parseEmoji('<a:spin:123456789012345678>')!;
    assert.equal(animated.animated, true);
    assert.equal(animated.display, '<a:spin:123456789012345678>');
  });

  it('accepts the bare name:id form people paste', () => {
    assert.equal(parseEmoji('pog:123456789012345678')!.reactionKey, 'pog:123456789012345678');
  });

  it('rejects junk', () => {
    assert.equal(parseEmoji(''), null);
    assert.equal(parseEmoji('this is not an emoji'), null);
  });
});

describe('mentions are locked down', () => {
  it('pings nobody by default', () => {
    assert.deepEqual(NO_MENTIONS, { parse: [], roles: [], users: [] });
  });

  it('can ping one member and still never a role or everyone', () => {
    const allowed = onlyUser('u1');
    assert.deepEqual(allowed.users, ['u1']);
    assert.deepEqual(allowed.parse, []);
    assert.deepEqual(allowed.roles, []);
  });
});

describe('member-facing screens stay small (acceptance test 7)', () => {
  const GTA = DEFAULT_SETTINGS.games.list.find((game) => game.id === 'gta')!;

  it('asks for the game in a single select', () => {
    const step = renderGameStep(DEFAULT_SETTINGS);
    assert.equal(step.components.length, 1, 'one row, one question');
  });

  it('offers Now / 15 / 30 / Other in one row', () => {
    const step = renderTimeStep(GTA, DEFAULT_SETTINGS);
    const row = step.components[0] as { components: { label?: string }[] };
    assert.deepEqual(
      row.components.map((component) => component.label),
      ['Now', '15 min', '30 min', 'Other time'],
    );
  });

  it('drops the custom button when an admin turns it off', () => {
    const settings = { ...DEFAULT_SETTINGS, games: { ...DEFAULT_SETTINGS.games, allowCustomTime: false } };
    const row = renderTimeStep(GTA, settings).components[0] as { components: unknown[] };
    assert.equal(row.components.length, 3);
  });

  it('says something when no games are set up, instead of an empty menu', () => {
    const settings = { ...DEFAULT_SETTINGS, games: { ...DEFAULT_SETTINGS.games, list: [] } };
    const step = renderGameStep(settings);
    assert.equal(step.components.length, 0);
    assert.ok(isSendable(step));
  });
});

/**
 * Regression guard. Discord rejects a message with components but no text,
 * which silently broke the whole Start a Game flow once already.
 */
describe('every screen is actually sendable', () => {
  const GTA = DEFAULT_SETTINGS.games.list.find((game) => game.id === 'gta')!;

  it('covers the member flow', () => {
    assert.ok(isSendable(renderGameStep(DEFAULT_SETTINGS)), 'game step');
    assert.ok(isSendable(renderTimeStep(GTA, DEFAULT_SETTINGS)), 'time step');
  });

  it('covers every admin screen', () => {
    assert.ok(isSendable(renderSettingsHome(DEFAULT_SETTINGS)), 'settings home');
    assert.ok(isSendable(renderSetup(DEFAULT_SETTINGS)), 'setup');
    assert.ok(isSendable(renderGamesHome(DEFAULT_SETTINGS)), 'games');
    assert.ok(isSendable(renderGamesHome(DEFAULT_SETTINGS, undefined, 'gta')), 'games with a selection');
    assert.ok(isSendable(renderEmojiHome(DEFAULT_SETTINGS)), 'emojis');
    for (const category of CATEGORIES) {
      if (CUSTOM_CATEGORIES.includes(category.key)) continue;
      assert.ok(isSendable(renderCategory(category.key, DEFAULT_SETTINGS)), category.key);
      for (const field of fieldsFor(category.key)) {
        assert.ok(isSendable(renderFieldEditor(field, DEFAULT_SETTINGS)), `${field.path} editor`);
      }
    }
  });
});

describe('admin screens render', () => {
  it('shows every category without exceeding Discord limits', () => {
    const home = renderSettingsHome(DEFAULT_SETTINGS);
    assert.ok(home.content.length < 2000);
    for (const category of CATEGORIES) {
      if (CUSTOM_CATEGORIES.includes(category.key)) continue;
      const view = renderCategory(category.key, DEFAULT_SETTINGS);
      assert.ok(view.content.length <= 1900, `${category.key} is too long`);
      assert.ok(view.components.length <= 5);
    }
  });
});

describe('the scheduler actually runs work', () => {
  it('runs a due job once and removes it', async () => {
    let runs = 0;
    registerJob('test.job', async () => {
      runs += 1;
    });
    schedule({ guildId: 'g1', kind: 'test.job', ref: 'a', runAt: Date.now() - 1000 });

    const client = {} as Client;
    await runDueJobs(client);
    await runDueJobs(client);

    assert.equal(runs, 1, 'a finished job must not run again');
    const left = getDb().prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number };
    assert.equal(left.n, 0);
  });

  it('leaves a future job alone', async () => {
    let runs = 0;
    registerJob('test.later', async () => {
      runs += 1;
    });
    schedule({ guildId: 'g1', kind: 'test.later', ref: 'b', runAt: Date.now() + 600_000 });
    await runDueJobs({} as Client);
    assert.equal(runs, 0);
  });

  it('retries a failing job instead of losing it', async () => {
    let attempts = 0;
    registerJob('test.flaky', async () => {
      attempts += 1;
      throw new Error('boom');
    });
    schedule({ guildId: 'g1', kind: 'test.flaky', ref: 'c', runAt: Date.now() - 1000 });
    await runDueJobs({} as Client);

    const row = getDb().prepare(`SELECT status, attempts FROM jobs WHERE ref = 'c'`).get() as {
      status: string;
      attempts: number;
    };
    assert.equal(attempts, 1);
    assert.equal(row.status, 'pending', 'queued for another try');
    assert.equal(row.attempts, 1);
  });
});
