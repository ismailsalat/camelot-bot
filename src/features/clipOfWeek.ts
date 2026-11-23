import { PermissionFlagsBits, type Client, type Guild, type Message } from 'discord.js';
import { clips, weekly } from '../db/repos.js';
import { getSettings, highlightsChannelId, type GuildSettings } from '../db/settings.js';
import { emojiFor } from '../util/emoji.js';
import { registerJob, schedule } from '../scheduler.js';
import { tallyMessage, voteEmojis } from './voting.js';
import { botCan, fetchTextChannel, messageLink, soft } from '../util/discord.js';
import { NO_MENTIONS } from '../util/mentions.js';
import { nextWeeklyOccurrence, weekKey } from '../util/time.js';
import { isModuleEnabled } from '../core/registry.js';
import { log } from '../logger.js';

export const JOB_WEEKLY = 'clips.weekly';

export interface Candidate {
  message: Message;
  authorId: string;
  score: number;
  up: number;
  createdAt: number;
}

/** Highest score wins; the earliest post breaks a tie. */
export function rankCandidates(candidates: Candidate[], minVotes: number): Candidate | null {
  const eligible = candidates.filter((candidate) => candidate.up >= minVotes && candidate.score > 0);
  if (eligible.length === 0) return null;
  return eligible.sort((a, b) => b.score - a.score || a.createdAt - b.createdAt)[0] ?? null;
}

/**
 * Re-reads reactions from Discord rather than trusting a cached count, skips
 * anything that has since been deleted, and never counts a post twice.
 */
export async function collectCandidates(
  guild: Guild,
  settings: GuildSettings,
  fromMs: number,
  toMs: number,
): Promise<Candidate[]> {
  const channel = await fetchTextChannel(guild, settings.channels.clips);
  if (!channel) return [];

  const rows = clips.inWindow(guild.id, fromMs, toMs);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const row of rows) {
    if (seen.has(row.message_id)) continue;
    seen.add(row.message_id);

    const message = await soft('fetch clip', () => channel.messages.fetch(row.message_id));
    if (!message) {
      clips.markDeleted(row.message_id); // deleted or no longer visible
      continue;
    }
    if (message.author.bot) continue;

    const tally = await tallyMessage(message, settings);
    candidates.push({
      message,
      authorId: message.author.id,
      score: tally.score,
      up: tally.up,
      createdAt: message.createdTimestamp,
    });
  }

  return candidates;
}

export async function runWeekly(client: Client, guildId: string, now = Date.now()): Promise<void> {
  const guild = await soft('fetch guild', () => client.guilds.fetch(guildId));
  if (!guild) return;

  const settings = getSettings(guildId);
  if (!isModuleEnabled(settings, 'clips')) return;

  const period = weekKey(now, settings.timezone);
  if (weekly.wasAnnounced(guildId, period)) {
    log.debug(`${guild.name}: ${period} already announced.`);
    return;
  }

  const from = now - 7 * 86_400_000;
  const candidates = await collectCandidates(guild, settings, from, now);
  const winner = rankCandidates(candidates, settings.weekly.minVotes);

  if (!winner) {
    // Claim the period so a restart doesn't re-run the search all evening.
    weekly.claim(guildId, period, null, 0);
    if (settings.weekly.announceNoWinner) {
      const channel = await fetchTextChannel(guild, highlightsChannelId(settings));
      if (channel && botCan(channel, PermissionFlagsBits.SendMessages)) {
        await soft('post no-winner notice', () =>
          channel.send({
            content: `No ${settings.weekly.title} this week.`,
            allowedMentions: NO_MENTIONS,
          }),
        );
      }
    }
    log.info(`${guild.name}: no eligible clip for ${period}.`);
    return;
  }

  // Claim before posting so two workers can never both announce.
  if (!weekly.claim(guildId, period, winner.message.id, winner.score)) return;

  const channel = await fetchTextChannel(guild, highlightsChannelId(settings));
  if (!channel || !botCan(channel, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages)) {
    log.warn(`${guild.name}: cannot post the weekly highlight — missing permissions.`);
    return;
  }

  const author = await soft('fetch winner member', () => guild.members.fetch(winner.authorId));
  const name = author?.displayName ?? winner.message.author.username;
  const link = messageLink(guild.id, winner.message.channelId, winner.message.id);
  const star = emojiFor(settings, 'star', client);
  const { up } = voteEmojis(settings, client);

  // Links back to the original post — never a re-upload.
  await soft('post weekly winner', () =>
    channel.send({
      content: `${star} **${settings.weekly.title}**\n${name} · ${up} ${winner.score}\n${link}`,
      allowedMentions: NO_MENTIONS,
    }),
  );
  log.info(`${guild.name}: ${settings.weekly.title} → ${winner.message.id} (${winner.score}).`);
}

/** (Re)queue the next run for a guild. Idempotent, so restarts are free. */
export function scheduleWeekly(guildId: string, from = Date.now()): void {
  const settings = getSettings(guildId);
  if (!isModuleEnabled(settings, 'clips')) return;
  const runAt = nextWeeklyOccurrence(settings.weekly.dayOfWeek, settings.weekly.time, settings.timezone, from);
  schedule({ guildId, kind: JOB_WEEKLY, ref: guildId, runAt });
  log.debug(`${guildId}: next ${settings.weekly.title} at ${new Date(runAt).toISOString()}`);
}

export function registerWeeklyJob(): void {
  registerJob(JOB_WEEKLY, async (client, job) => {
    try {
      await runWeekly(client, job.guild_id);
    } finally {
      // Always line up the following week, even if this run found nothing.
      scheduleWeekly(job.guild_id, Date.now() + 60_000);
    }
  });
}
