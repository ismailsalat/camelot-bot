import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import type { Guild, GuildMember } from 'discord.js';
import { openTestDatabase } from '../db/index.js';
import { clearSettingsCache, getSettings, setByPath } from '../db/settings.js';
import { DEFAULT_PREFIX, isValidPrefix, readPrefix } from '../env.js';
import {
  hostPrefixValue,
  parseCommand,
  prefixFor,
  resolveTarget,
  setHostPrefix,
  textCommandsEnabled,
} from '../core/prefix.js';
import { setLogLevel } from '../logger.js';

const GUILD = 'g-prefix';

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
  setHostPrefix(DEFAULT_PREFIX);
  setLogLevel('error');
});

describe('prefix validation', () => {
  it('accepts short punctuation', () => {
    for (const value of ['!', '?', '.', '$', '%', '-', '!!', '!?', '--', '...']) {
      assert.ok(isValidPrefix(value), value);
    }
  });

  it('rejects anything Discord treats specially', () => {
    // `/` opens the slash menu, `@` and `#` open the mention picker, `<` starts
    // a mention token and a backtick starts code — none can begin a command.
    for (const value of ['/', '@', '#', '<', '>', '`', '/a', '@here']) {
      assert.ok(!isValidPrefix(value), value);
    }
  });

  it('rejects letters and digits, so ordinary sentences stay ordinary', () => {
    for (const value of ['a', 'go', '1', '!a', 'a!']) {
      assert.ok(!isValidPrefix(value), value);
    }
  });

  it('rejects empty and over-long prefixes', () => {
    assert.ok(!isValidPrefix(''));
    assert.ok(!isValidPrefix('!!!!'));
  });

  it('falls back to the default rather than refusing to boot', () => {
    const warnings: string[] = [];
    assert.equal(readPrefix('%%', (message) => warnings.push(message)), '%%');
    assert.equal(warnings.length, 0);

    assert.equal(readPrefix('nope', (message) => warnings.push(message)), DEFAULT_PREFIX);
    assert.equal(warnings.length, 1, 'a bad value is reported, not silently swallowed');
  });

  it('treats an unset variable as the default', () => {
    assert.equal(readPrefix(undefined), DEFAULT_PREFIX);
  });
});

describe('which prefix a server uses', () => {
  it('follows the host when the server has set nothing', () => {
    setHostPrefix('?');
    assert.equal(hostPrefixValue(), '?');
    assert.equal(prefixFor(GUILD), '?');
  });

  it('lets a server override the host', () => {
    setHostPrefix('!');
    setByPath(GUILD, 'core.prefix', '$');
    assert.equal(prefixFor(GUILD), '$');
  });

  it('hands a server back to the host when its prefix is cleared', () => {
    setHostPrefix('.');
    setByPath(GUILD, 'core.prefix', '$');
    setByPath(GUILD, 'core.prefix', null);
    assert.equal(prefixFor(GUILD), '.');
  });

  it('ignores a stored prefix that could never work', () => {
    // A value written straight into the database, bypassing the modal.
    setHostPrefix('!');
    setByPath(GUILD, 'core.prefix', '@everyone');
    assert.equal(prefixFor(GUILD), '!', 'a junk value must not disable commands');
  });

  it('refuses a bad host prefix too', () => {
    setHostPrefix('/');
    assert.equal(hostPrefixValue(), DEFAULT_PREFIX);
  });

  it('is on by default and can be switched off', () => {
    assert.equal(textCommandsEnabled(GUILD), true);
    setByPath(GUILD, 'core.textCommands', false);
    assert.equal(textCommandsEnabled(GUILD), false);
  });
});

describe('reading a text command', () => {
  it('finds a bare command', () => {
    assert.deepEqual(parseCommand('!allies', '!'), { name: 'activity', typed: 'allies', args: [] });
  });

  it('resolves an alias to the one handler behind it', () => {
    assert.equal(parseCommand('!allies', '!')?.name, 'activity');
    assert.equal(parseCommand('!activity', '!')?.name, 'activity');
  });

  it('is case-insensitive', () => {
    assert.equal(parseCommand('!ALLIES', '!')?.name, 'activity');
    assert.equal(parseCommand('!Purge', '!')?.name, 'purge');
  });

  it('keeps the arguments', () => {
    assert.deepEqual(parseCommand('!purge <@123456789012345678>', '!')?.args, ['<@123456789012345678>']);
    assert.deepEqual(parseCommand('!allies  big   gail ', '!')?.args, ['big', 'gail']);
  });

  it('ignores a message that is not a command', () => {
    for (const content of ['hello', 'allies', '', '   ', 'the !allies thing']) {
      assert.equal(parseCommand(content, '!'), null, JSON.stringify(content));
    }
  });

  it('ignores punctuation that merely starts with the prefix', () => {
    // The thing people actually type: "!!!", "!?", "!...".
    for (const content of ['!', '!!', '!!!', '!?', '!...', '!@#']) {
      assert.equal(parseCommand(content, '!'), null, JSON.stringify(content));
    }
  });

  it('ignores a command Camelot does not have', () => {
    assert.equal(parseCommand('!ban someone', '!'), null);
    assert.equal(parseCommand('!play music', '!'), null);
  });

  it('honours a multi-character prefix', () => {
    assert.equal(parseCommand('!!allies', '!!')?.name, 'activity');
    assert.equal(parseCommand('!allies', '!!'), null, 'a single ! is not the prefix here');
  });

  it('does not confuse one prefix for another', () => {
    assert.equal(parseCommand('?allies', '!'), null);
    assert.equal(parseCommand('?allies', '?')?.name, 'activity');
  });
});

/* ------------------------------ target lookup ------------------------------ */

function fakeMember(id: string, displayName: string, username = displayName, bot = false): GuildMember {
  return { id, displayName, user: { username, bot } } as unknown as GuildMember;
}

function fakeGuild(members: GuildMember[], fetchable: GuildMember[] = []): Guild {
  const cache = new Map(members.map((member) => [member.id, member]));
  const remote = new Map(fetchable.map((member) => [member.id, member]));
  return {
    members: {
      cache,
      fetch: async (id: string) => {
        const found = remote.get(id) ?? cache.get(id);
        if (!found) throw new Error('Unknown Member');
        return found;
      },
    },
  } as unknown as Guild;
}

describe('who a text command is aimed at', () => {
  const gail = fakeMember('111111111111111111', 'Gail');
  const spatz = fakeMember('222222222222222222', 'Spatz', 'spatz_real');
  const gary = fakeMember('333333333333333333', 'Gary');

  it('is nobody when no argument is given', async () => {
    assert.equal(await resolveTarget(fakeGuild([gail]), []), null);
    assert.equal(await resolveTarget(fakeGuild([gail]), ['']), null);
  });

  it('reads a plain mention', async () => {
    const found = await resolveTarget(fakeGuild([gail]), ['<@111111111111111111>']);
    assert.equal(found, gail);
  });

  it('reads the old nickname mention form', async () => {
    const found = await resolveTarget(fakeGuild([gail]), ['<@!111111111111111111>']);
    assert.equal(found, gail);
  });

  it('reads a raw id', async () => {
    assert.equal(await resolveTarget(fakeGuild([gail]), ['111111111111111111']), gail);
  });

  it('fetches someone who is not cached', async () => {
    assert.equal(await resolveTarget(fakeGuild([], [gail]), ['111111111111111111']), gail);
  });

  it('says so when an id belongs to nobody here', async () => {
    assert.equal(await resolveTarget(fakeGuild([gail]), ['999999999999999999']), 'not-found');
  });

  it('matches a display name', async () => {
    assert.equal(await resolveTarget(fakeGuild([gail, spatz]), ['gail']), gail);
  });

  it('matches a username', async () => {
    assert.equal(await resolveTarget(fakeGuild([gail, spatz]), ['spatz_real']), spatz);
  });

  it('matches a name with spaces in it', async () => {
    const big = fakeMember('444444444444444444', 'Big Gail');
    assert.equal(await resolveTarget(fakeGuild([big, gail]), ['big', 'gail']), big);
  });

  it('prefers an exact name over a longer one that starts the same', async () => {
    const gailey = fakeMember('555555555555555555', 'Gailey');
    assert.equal(await resolveTarget(fakeGuild([gailey, gail]), ['gail']), gail);
  });

  it('refuses to guess between two matches', async () => {
    // "ga" fits both Gail and Gary. Picking one would eventually kick the
    // wrong person, so it asks instead.
    assert.equal(await resolveTarget(fakeGuild([gail, gary]), ['ga']), 'not-found');
  });

  it('never resolves to a bot', async () => {
    const bot = fakeMember('666666666666666666', 'Camelot', 'camelot', true);
    assert.equal(await resolveTarget(fakeGuild([bot]), ['camelot']), 'not-found');
  });
});

describe('a text command does not pay for itself in activity', () => {
  it('a command is recognised as a command, not conversation', () => {
    // The guard the message handler uses: anything parseCommand claims is
    // excluded from activity tracking, so `!allies` cannot farm the score
    // that `!allies` reports.
    assert.ok(parseCommand('!allies', prefixFor(GUILD)) !== null);
    assert.ok(parseCommand('anyone around?', prefixFor(GUILD)) === null);
  });

  it('stops being a command when the server turns text commands off', () => {
    setByPath(GUILD, 'core.textCommands', false);
    assert.equal(getSettings(GUILD).core.textCommands, false);
  });
});

describe('publishing commands only when they change', () => {
  it('remembers nothing on a fresh deployment', async () => {
    const { meta } = await import('../db/index.js');
    assert.equal(meta.get('commands.fingerprint'), null);
  });

  it('round-trips through the meta store', async () => {
    const { meta } = await import('../db/index.js');
    meta.set('commands.fingerprint', 'abc123');
    assert.equal(meta.get('commands.fingerprint'), 'abc123');
    meta.set('commands.fingerprint', 'def456');
    assert.equal(meta.get('commands.fingerprint'), 'def456', 'a second write replaces the first');
  });

  it('is stable across calls, so an unchanged deploy publishes nothing', async () => {
    const { commandFingerprint } = await import('../core/publish.js');
    assert.equal(commandFingerprint(), commandFingerprint());
  });

  it('differs between global and a dev guild', async () => {
    // Otherwise switching DEV_GUILD_ID would leave the old scope's commands up.
    const { commandFingerprint } = await import('../core/publish.js');
    assert.notEqual(commandFingerprint(), commandFingerprint('123'));
  });

  it('covers the options, not just the names', async () => {
    // A user option added to an existing command has to republish, or
    // `/allies @someone` would quietly have nowhere to put the mention.
    const { createHash } = await import('node:crypto');
    const { buildCommands } = await import('../core/commands.js');
    const body = buildCommands().map((command) => command.toJSON());
    const hash = (value: unknown) =>
      createHash('sha256').update(`global\n${JSON.stringify(value)}`).digest('hex').slice(0, 32);

    const stripped = body.map((command) => ({ ...command, options: [] }));
    assert.notEqual(hash(body), hash(stripped), 'dropping the options must move the fingerprint');
  });
});
