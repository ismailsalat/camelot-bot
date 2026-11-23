import type { Guild, GuildMember } from 'discord.js';
import { getSettings } from '../db/settings.js';
import { summarise } from '../activity/summary.js';
import { canBotKick, isAdmin } from '../core/permissions.js';
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
  | 'exempt'
  | 'hierarchy'
  | 'permissions'
  | 'became-active'
  | 'unreliable';

export interface Verdict {
  userId: string;
  member: GuildMember | null;
  ok: boolean;
  reason: BlockReason | null;
  detail: string;
}

export interface RevalidateOptions {
  /** When the review decision was made — activity since then earns a re-look. */
  decidedAt: number;
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

  for (const userId of userIds) {
    const member = await soft(`fetch member ${userId}`, () => guild.members.fetch(userId));

    if (!actorStillAuthorised) {
      verdicts.push({ userId, member: member ?? null, ok: false, reason: 'permissions', detail: 'You are no longer an admin here.' });
      continue;
    }
    if (!member) {
      verdicts.push({ userId, member: null, ok: false, reason: 'gone', detail: 'Already left the server.' });
      continue;
    }

    const facts: MemberFacts = {
      userId,
      isOwner: member.id === guild.ownerId,
      isBot: member.user.bot,
      roleIds: [...member.roles.cache.keys()],
      joinedAt: member.joinedTimestamp,
    };

    const protection = protectionFor(facts, settings, exemptions.get(guild.id, userId));
    if (protection.kind === 'owner') {
      verdicts.push({ userId, member, ok: false, reason: 'owner', detail: 'Server owner.' });
      continue;
    }
    if (protection.kind === 'exempt') {
      verdicts.push({ userId, member, ok: false, reason: 'exempt', detail: 'Marked as away since the review.' });
      continue;
    }
    if (isProtected(protection)) {
      verdicts.push({ userId, member, ok: false, reason: 'protected', detail: 'Now has a protected role.' });
      continue;
    }

    const summary = summarise(guild.id, userId, settings);

    if (summary.observedDays < settings.purge.minObservedDays) {
      verdicts.push({
        userId,
        member,
        ok: false,
        reason: 'unreliable',
        detail: 'Not enough tracked history to be sure.',
      });
      continue;
    }

    // Activity since the decision was taken means the review is out of date.
    if (summary.daysSinceActive !== null) {
      const lastActiveMs = Date.now() - summary.daysSinceActive * 86_400_000;
      if (lastActiveMs > options.decidedAt) {
        verdicts.push({
          userId,
          member,
          ok: false,
          reason: 'became-active',
          detail: 'Active again since you reviewed them.',
        });
        continue;
      }
    }

    const kickable = canBotKick(guild, member);
    if (!kickable.ok) {
      verdicts.push({
        userId,
        member,
        ok: false,
        reason: kickable.reason.includes('permission') ? 'permissions' : 'hierarchy',
        detail: kickable.reason,
      });
      continue;
    }

    verdicts.push({ userId, member, ok: true, reason: null, detail: 'Ready.' });
  }

  return verdicts;
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
): Promise<KickOutcome[]> {
  const outcomes: KickOutcome[] = [];
  const done = new Set<string>();

  for (const verdict of verdicts) {
    if (!verdict.ok || !verdict.member) continue;
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
