import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import { PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { openTestDatabase } from '../db/index.js';
import { clearSettingsCache, setByPath } from '../db/settings.js';
import { revalidate, removable, type Verdict } from '../purge/execute.js';
import { exemptions } from '../purge/policy.js';
import { store, recentDays } from '../activity/store.js';
import { setLogLevel } from '../logger.js';

/**
 * Drives the real `revalidate` against fake Discord objects, because the
 * question "may this admin remove this person" is answered by several pieces
 * working together — permissions, protections, tracking history — and testing
 * them one at a time would not catch them disagreeing.
 */

const GUILD = 'g-override';
const OWNER = 'u-owner';
const LOCKED_ROLE = 'r-locked';
const MOD_ROLE = 'r-mod';

const perms = (...flags: bigint[]) => ({ has: (flag: bigint) => flags.includes(flag) });

interface FakePerson {
  roles?: string[];
  kickable?: boolean;
  permissions?: ReturnType<typeof perms>;
}

const people = new Map<string, GuildMember>();

function person(id: string, options: FakePerson = {}): GuildMember {
  const member = {
    id,
    displayName: id,
    user: { bot: false, username: id },
    roles: { cache: new Map((options.roles ?? []).map((role) => [role, { id: role }])) },
    kickable: options.kickable ?? true,
    joinedTimestamp: Date.now() - 400 * 86_400_000,
    permissions: options.permissions ?? perms(),
  } as unknown as GuildMember;
  (member as { guild?: Guild }).guild = guild;
  people.set(id, member);
  return member;
}

const guild = {
  id: GUILD,
  ownerId: OWNER,
  members: {
    me: { permissions: perms(PermissionFlagsBits.KickMembers) },
    fetch: async (id: string) => {
      const found = people.get(id);
      if (!found) throw new Error('Unknown Member');
      return found;
    },
  },
} as unknown as Guild;

const TARGETS = ['ordinary', 'modrole', 'lockedrole', 'above', OWNER, 'away'];

let asAdmin: Verdict[] = [];
let asOwner: Verdict[] = [];
let asPlain: Verdict[] = [];

before(async () => {
  setLogLevel('error');
  openTestDatabase();
  clearSettingsCache();
  people.clear();

  setByPath(GUILD, 'purge.absoluteRoles', [LOCKED_ROLE]);
  setByPath(GUILD, 'purge.rolePolicies', [{ roleId: MOD_ROLE, effect: 'protect' }]);
  setByPath(GUILD, 'permissions.adminRoles', ['r-admin']);
  clearSettingsCache();

  // A server that has really been running: 30 fully observed days in which
  // nobody said anything. Without this everyone is flagged for thin history,
  // which is right on day one but would hide the distinctions under test.
  for (const day of recentDays(30, 'America/Los_Angeles')) store.addCoverage(GUILD, day, 86_400);

  person(OWNER);
  person('u-admin', { roles: ['r-admin'] });
  person('u-plain');
  person('ordinary');
  person('modrole', { roles: [MOD_ROLE] });
  person('lockedrole', { roles: [LOCKED_ROLE] });
  person('above', { kickable: false });
  person('away');
  exemptions.set(GUILD, 'away', Date.now() + 7 * 86_400_000, null, OWNER);

  asAdmin = await revalidate(guild, TARGETS, 'u-admin', {});
  asOwner = await revalidate(guild, TARGETS, OWNER, {});
  asPlain = await revalidate(guild, TARGETS, 'u-plain', {});
});

const sev = (list: Verdict[], id: string) => list.find((verdict) => verdict.userId === id)?.severity;
const ids = (list: Verdict[]) => list.map((verdict) => verdict.userId);

describe('what an admin may decide', () => {
  it('clears an ordinary quiet member', () => {
    assert.equal(sev(asAdmin, 'ordinary'), 'ok');
  });

  it('turns a protected role into a caution, not a veto', () => {
    assert.equal(sev(asAdmin, 'modrole'), 'warn');
  });

  it('turns an away mark into a caution', () => {
    assert.equal(sev(asAdmin, 'away'), 'warn');
  });
});

describe('what nobody may decide', () => {
  it('will not touch a role above the bot', () => {
    assert.equal(sev(asAdmin, 'above'), 'block');
    assert.equal(sev(asOwner, 'above'), 'block');
  });

  it('will not touch the server owner, even for the owner', () => {
    assert.equal(sev(asAdmin, OWNER), 'block');
    assert.equal(sev(asOwner, OWNER), 'block');
  });

  it('gives a non-admin nothing at all', () => {
    assert.ok(asPlain.every((verdict) => verdict.severity === 'block'));
  });
});

describe('what only the owner may decide', () => {
  it('walls an absolute role off from an admin', () => {
    assert.equal(sev(asAdmin, 'lockedrole'), 'block');
  });

  it('lets the owner override the list the owner wrote', () => {
    assert.equal(sev(asOwner, 'lockedrole'), 'warn');
  });
});

describe('what the buttons would actually do', () => {
  it('removes only the ready one by default', () => {
    assert.deepEqual(ids(removable(asAdmin, false)), ['ordinary']);
  });

  it('removes every caution when the admin overrides', () => {
    assert.deepEqual(ids(removable(asAdmin, true)), ['ordinary', 'modrole', 'away']);
  });

  it('reaches the locked role when the owner overrides', () => {
    assert.ok(ids(removable(asOwner, true)).includes('lockedrole'));
  });

  it('never reaches a wall, however hard anyone asks', () => {
    for (const list of [asAdmin, asOwner, asPlain]) {
      assert.ok(removable(list, true).every((verdict) => verdict.severity !== 'block'));
    }
  });

  it('gives a non-admin nothing to remove', () => {
    assert.equal(removable(asPlain, true).length, 0);
  });
});
