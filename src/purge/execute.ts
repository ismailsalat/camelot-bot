import type { Guild, GuildMember } from 'discord.js';
import { getSettings } from '../db/settings.js';
import { summarise } from '../activity/summary.js';
import { canBotKick, isAdmin, tierOf, type Tier } from '../core/permissions.js';
import { exemptions, isProtected, protectionFor, type MemberFacts } from './policy.js';
import { purgeLog } from './session.js';
import { soft } from '../util/discord.js';
import { log } from '../logger.js';

/**
 * Nothing here trusts the review. Every decision is re-checked against live
 * Discord state immediately before the kick, because minutes or days may have
 * passed and the answer may have changed.
 */

export type BlockReason =
  | 'gone'
  | 'owner'
  | 'protected'
  | 'absolute'
  | 'exempt'
  | 'hierarchy'
  | 'permissions'
  | 'became-active'
  | 'unreliable';

/**
 * 'block' can never be overridden. Those are the things that are not the
 * admin's to decide: Discord refuses the kick outright, or the server owner
 * has locked the member behind an absolute role.
 *
 * 'warn' is a caution, not a veto. It covers Camelot's doubts about its own
 * data and the server's own soft settings — a protected role, an away mark.
 * Someone who has looked at the person and the settings they themselves wrote
 * is better placed to judge than a thin tracking history is, so they get the
 * final word.
 */
export type Severity = 'ok' | 'warn' | 'block';

export interface Verdict {
  userId: string;
  member: GuildMember | null;
  ok: boolean;
  severity: Severity;
  reason: BlockReason | null;
  detail: string;
}

export interface RevalidateOptions {
  /**
   * When the review decision was made — activity since then earns a re-look.
   * Left out when the command names one person right now, because there is no
   * earlier decision that could have gone stale.
   */
  decidedAt?: number;
}

/**
 * An absolute role is the one protection an admin cannot talk their way past;
 * it exists precisely so the owner can put someone out of reach. The owner,
 * whose list it is, can still override it.
 */
function absoluteSeverity(tier: Tier): Severity {
  return tier === 'owner' ? 'warn' : 'block';
}

export async function revalidate(
  guild: Guild,
  userIds: string[],
  actorId: string,
  options: RevalidateOptions,
): Promise<Verdict[]> {
  const settings = getSettings(guild.id);
  const verdicts: Verdict[] = [];

  const actor = await soft('fetch actor', () => guild.members.fetch(actorId));
  const actorStillAuthorised = !!actor && isAdmin(actor);
  const tier: Tier = actor ? tierOf(actor) : 'member';

  for (const userId of userIds) {
    const member = await soft(`fetch member ${userId}`, () => guild.members.fetch(userId));

    if (!actorStillAuthorised) {
      verdicts.push({
        userId,
        member: member ?? null,
        ok: false,
        severity: 'block',
        reason: 'permissions',
        detail: 'You are no longer an admin here.',
      });
      continue;
    }
    if (!member) {
      verdicts.push({ userId, member: null, ok: false, severity: 'block', reason: 'gone', detail: 'Already left.' });
      continue;
    }

    const facts: MemberFacts = {
      userId,
      isOwner: member.id === guild.ownerId,
      isBot: member.user.bot,
      roleIds: [...member.roles.cache.keys()],
      joinedAt: member.joinedTimestamp,
    };

    // Discord's own refusals come first. Nothing below can override these, so
    // checking them early keeps a softer warning from masking a hard stop.
    const kickable = canBotKick(guild, member);
    if (!kickable.ok) {
      verdicts.push({
        userId,
        member,
        ok: false,
        severity: 'block',
        reason: kickable.reason.includes('permission')
          ? 'permissions'
          : kickable.reason.includes('owner')
            ? 'owner'
            : 'hierarchy',
        detail: kickable.reason,
      });
      continue;
    }

    const protection = protectionFor(facts, settings, exemptions.get(guild.id, userId));

    if (protection.kind === 'absolute') {
      verdicts.push({
        userId,
        member,
        ok: false,
        severity: absoluteSeverity(tier),
        reason: 'absolute',
        detail:
          tier === 'owner'
            ? 'Protected role you locked. Yours to override.'
            : 'Protected role. Only the server owner can override it.',
      });
      continue;
    }

    if (protection.kind === 'exempt') {
      verdicts.push({
        userId,
        member,
        ok: false,
        severity: 'warn',
        reason: 'exempt',
        detail: 'Marked as away.',
      });
      continue;
    }

    if (isProtected(protection)) {
      verdicts.push({
        userId,
        member,
        ok: false,
        severity: 'warn',
        reason: 'protected',
        detail: 'Has a protected role.',
      });
      continue;
    }

    const summary = summarise(guild.id, userId, settings);

    // From here the warnings are about Camelot's own data, not about whether
    // the removal is allowed. They are shown, and you decide.
    if (summary.observedDays < settings.purge.minObservedDays) {
      verdicts.push({
        userId,
        member,
        ok: false,
        severity: 'warn',
        reason: 'unreliable',
        detail: `Only ${summary.observedDays} tracked day${summary.observedDays === 1 ? '' : 's'} of history.`,
      });
      continue;
    }

    // Activity since the decision was taken means the review is out of date.
    if (options.decidedAt !== undefined && summary.daysSinceActive !== null) {
      const lastActiveMs = Date.now() - summary.daysSinceActive * 86_400_000;
      if (lastActiveMs > options.decidedAt) {
        verdicts.push({
          userId,
          member,
          ok: false,
          severity: 'warn',
          reason: 'became-active',
          detail: 'Active again since you reviewed them.',
        });
        continue;
      }
    }

    verdicts.push({ userId, member, ok: true, severity: 'ok', reason: null, detail: 'Ready.' });
  }

  return verdicts;
}

/** Everyone who would actually be removed, given the choice about warnings. */
export function removable(verdicts: Verdict[], includeWarned: boolean): Verdict[] {
  return verdicts.filter(
    (verdict) => verdict.severity === 'ok' || (includeWarned && verdict.severity === 'warn'),
  );
}

export interface KickOutcome {
  userId: string;
  name: string;
  success: boolean;
  detail: string;
}

/** Kicks are attempted one at a time; one failure never stops the rest. */
export async function executeKicks(
  guild: Guild,
  verdicts: Verdict[],
  actorId: string,
  reason: string,
  options: { includeWarned?: boolean } = {},
): Promise<KickOutcome[]> {
  const outcomes: KickOutcome[] = [];
  const done = new Set<string>();

  for (const verdict of verdicts) {
    const allowed = verdict.ok || (options.includeWarned === true && verdict.severity === 'warn');
    // A hard block is never overridable, whatever the caller asks for.
    if (!allowed || verdict.severity === 'block' || !verdict.member) continue;
    // Belt and braces against a double submit.
    if (done.has(verdict.userId)) continue;
    done.add(verdict.userId);

    const name = verdict.member.displayName;
    try {
      await verdict.member.kick(reason);
      purgeLog.record({ guildId: guild.id, actorId, userId: verdict.userId, reason, success: true });
      outcomes.push({ userId: verdict.userId, name, success: true, detail: 'Removed.' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      log.error(`Kick failed for ${verdict.userId} in ${guild.id}`, error);
      purgeLog.record({
        guildId: guild.id,
        actorId,
        userId: verdict.userId,
        reason,
        success: false,
        detail,
      });
      outcomes.push({ userId: verdict.userId, name, success: false, detail: "Couldn't remove them." });
    }
  }

  return outcomes;
}
