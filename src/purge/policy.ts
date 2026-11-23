import { getDb } from '../db/index.js';
import type { GuildSettings } from '../db/settings.js';
import type { MemberSummary } from '../activity/summary.js';

/**
 * Who may be reviewed, who may be removed, and why. Everything here is pure
 * except the exemption store, so the rules are fully testable without Discord.
 */

export type Protection =
  | { kind: 'none' }
  | { kind: 'owner' }
  | { kind: 'absolute'; roleId: string }
  | { kind: 'role'; roleId: string }
  | { kind: 'exempt'; until: number; note: string | null };

export interface MemberFacts {
  userId: string;
  isOwner: boolean;
  isBot: boolean;
  roleIds: string[];
  /** When they joined the server. */
  joinedAt: number | null;
}

/**
 * Role policies are evaluated in priority order and the first match wins —
 * they never stack. Absolute protection is a separate override that beats
 * everything, including a later "normal" policy.
 */
export function protectionFor(
  facts: MemberFacts,
  settings: GuildSettings,
  exemption?: { until: number; note: string | null } | null,
  now = Date.now(),
): Protection {
  if (facts.isOwner) return { kind: 'owner' };

  const absolute = settings.purge.absoluteRoles.find((roleId) => facts.roleIds.includes(roleId));
  if (absolute) return { kind: 'absolute', roleId: absolute };

  if (exemption && exemption.until > now) {
    return { kind: 'exempt', until: exemption.until, note: exemption.note };
  }

  for (const policy of settings.purge.rolePolicies) {
    if (!facts.roleIds.includes(policy.roleId)) continue;
    // First applicable policy decides. A "normal" policy here means this role
    // explicitly confers nothing, and stops lower-priority roles applying.
    return policy.effect === 'protect' ? { kind: 'role', roleId: policy.roleId } : { kind: 'none' };
  }

  return { kind: 'none' };
}

export function isProtected(protection: Protection): boolean {
  return protection.kind !== 'none';
}

/**
 * A wall is a protection the person asking cannot move: the server owner, and
 * an absolute role for anyone but the owner who locked it. Everything else is
 * a caution — the server's own soft setting, which its author may override.
 */
export function isWall(protection: Protection, tier: 'member' | 'admin' | 'owner'): boolean {
  if (protection.kind === 'owner') return true;
  if (protection.kind === 'absolute') return tier !== 'owner';
  return false;
}

export function describeProtection(protection: Protection): string | null {
  switch (protection.kind) {
    case 'owner':
      return 'Server owner';
    case 'absolute':
      return 'Protected role';
    case 'role':
      return 'Protected role';
    case 'exempt':
      return `Away until <t:${Math.floor(protection.until / 1000)}:d>`;
    default:
      return null;
  }
}

export type Scope = 'inactive' | 'eligible' | 'all';

export interface CandidateInput {
  facts: MemberFacts;
  summary: MemberSummary;
  protection: Protection;
}

export interface Candidate extends CandidateInput {
  /** Protected members can be viewed but never removed. */
  reviewable: boolean;
  /** Why they showed up in an inactive filter. */
  reason: string | null;
}

/**
 * The inactivity filter deliberately leans on observed history rather than a
 * low score. Someone can score low simply because tracking is young, and that
 * is not evidence about them.
 */
export function selectCandidates(
  inputs: CandidateInput[],
  scope: Scope,
  settings: GuildSettings,
  now = Date.now(),
  tier: 'member' | 'admin' | 'owner' = 'admin',
): Candidate[] {
  const graceMs = settings.activity.gracePeriodDays * 86_400_000;

  const decorated = inputs
    .filter((input) => !input.facts.isBot)
    .map((input) => {
      const protectedMember = isProtected(input.protection);
      const walled = isWall(input.protection, tier);
      const newcomer = input.facts.joinedAt !== null && now - input.facts.joinedAt < graceMs;
      const enoughHistory = input.summary.observedDays >= settings.purge.minObservedDays;
      const quietLongEnough =
        input.summary.daysSinceActive === null || input.summary.daysSinceActive >= settings.purge.inactivityDays;

      let reason: string | null = null;
      let inactive = false;
      if (!newcomer && enoughHistory && quietLongEnough) {
        inactive = true;
        reason =
          input.summary.daysSinceActive === null
            ? 'No qualifying activity recorded'
            : `Quiet for ${input.summary.daysSinceActive} days`;
      }

      return { input, protectedMember, walled, newcomer, enoughHistory, inactive, reason };
    });

  const chosen = decorated.filter((entry) => {
    if (scope === 'all') return true;
    // "Everyone I can remove" means exactly that, so it now includes members
    // behind a soft protection the viewer is allowed to override.
    if (scope === 'eligible') return !entry.walled;
    // The automatic inactive filter stays conservative: a protected role or an
    // away mark keeps you out of it, which is the point of setting one. Those
    // members are still reachable through Everyone, or by naming them.
    return entry.inactive && !entry.protectedMember;
  });

  return chosen
    .map(
      (entry): Candidate => ({
        ...entry.input,
        reviewable: !entry.walled,
        reason: entry.reason,
      }),
    )
    .sort(byQuietestFirst);
}

/** Least recent qualifying activity first; never-active members lead. */
function byQuietestFirst(a: Candidate, b: Candidate): number {
  const aDays = a.summary.daysSinceActive;
  const bDays = b.summary.daysSinceActive;
  if (aDays === null && bDays === null) return a.summary.score - b.summary.score;
  if (aDays === null) return -1;
  if (bDays === null) return 1;
  if (aDays !== bDays) return bDays - aDays;
  return a.summary.score - b.summary.score;
}

/* ------------------------------- exemptions -------------------------------- */

export interface Exemption {
  userId: string;
  until: number;
  note: string | null;
  setBy: string;
  setAt: number;
}

export const exemptions = {
  get(guildId: string, userId: string, now = Date.now()): Exemption | null {
    const row = getDb()
      .prepare(`SELECT user_id, until, note, set_by, set_at FROM member_exemptions WHERE guild_id = ? AND user_id = ?`)
      .get(guildId, userId) as
      | { user_id: string; until: number; note: string | null; set_by: string; set_at: number }
      | undefined;
    if (!row) return null;
    if (row.until <= now) return null; // expired exemptions simply stop applying
    return { userId: row.user_id, until: row.until, note: row.note, setBy: row.set_by, setAt: row.set_at };
  },

  all(guildId: string, now = Date.now()): Exemption[] {
    return (
      getDb()
        .prepare(
          `SELECT user_id, until, note, set_by, set_at FROM member_exemptions WHERE guild_id = ? AND until > ? ORDER BY until`,
        )
        .all(guildId, now) as {
        user_id: string;
        until: number;
        note: string | null;
        set_by: string;
        set_at: number;
      }[]
    ).map((row) => ({
      userId: row.user_id,
      until: row.until,
      note: row.note,
      setBy: row.set_by,
      setAt: row.set_at,
    }));
  },

  set(guildId: string, userId: string, until: number, note: string | null, setBy: string): void {
    getDb()
      .prepare(
        `INSERT INTO member_exemptions (guild_id, user_id, until, note, set_by, set_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET
           until = excluded.until, note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(guildId, userId, until, note, setBy, Date.now());
  },

  clear(guildId: string, userId: string): void {
    getDb().prepare(`DELETE FROM member_exemptions WHERE guild_id = ? AND user_id = ?`).run(guildId, userId);
  },

  /** Expired rows are dead weight; drop them on the daily tidy-up. */
  pruneExpired(now = Date.now()): number {
    return getDb().prepare(`DELETE FROM member_exemptions WHERE until <= ?`).run(now).changes;
  },
};
