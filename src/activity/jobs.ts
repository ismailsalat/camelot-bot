import type { Client } from 'discord.js';
import { getSettings } from '../db/settings.js';
import { isModuleEnabled } from '../core/registry.js';
import { registerJob, schedule } from '../scheduler.js';
import { dayKey, store } from './store.js';
import { sweepVoice } from './tracker.js';
import { exemptions } from '../purge/policy.js';
import { purgeLog, reviews } from '../purge/session.js';
import { log } from '../logger.js';

export const JOB_UPKEEP = 'activity.upkeep';

/**
 * Coverage heartbeat. Credits only the time actually elapsed between ticks,
 * capped, so a restart or an outage leaves a visible gap instead of silently
 * counting as "we were watching".
 */
const COVERAGE_INTERVAL_MS = 5 * 60 * 1000;
let coverageTimer: NodeJS.Timeout | undefined;
let lastTick = 0;

export function startCoverage(client: Client, intervalMs = COVERAGE_INTERVAL_MS): void {
  if (coverageTimer) return;
  lastTick = Date.now();

  const tick = () => {
    const now = Date.now();
    const elapsed = Math.min(now - lastTick, intervalMs * 2);
    lastTick = now;
    if (elapsed <= 0) return;

    for (const guild of client.guilds.cache.values()) {
      const settings = getSettings(guild.id);
      if (!isModuleEnabled(settings, 'activity') || !settings.activity.enabled) continue;
      store.addCoverage(guild.id, dayKey(now, settings.timezone), Math.floor(elapsed / 1000));
    }

    // Safety net: if a gateway event was missed, this puts voice sessions back
    // in line with who is actually sitting in a channel.
    try {
      sweepVoice(client, now);
    } catch (error) {
      log.error('Voice sweep failed', error);
    }
  };

  coverageTimer = setInterval(tick, intervalMs);
  if (typeof coverageTimer.unref === 'function') coverageTimer.unref();
}

export function stopCoverage(): void {
  if (coverageTimer) clearInterval(coverageTimer);
  coverageTimer = undefined;
}

/** Daily tidy-up: old summaries, expired exemptions, abandoned reviews. */
export function scheduleUpkeep(guildId: string, from = Date.now()): void {
  schedule({ guildId, kind: JOB_UPKEEP, ref: guildId, runAt: from + 60 * 60 * 1000 });
}

export function registerUpkeepJobs(): void {
  registerJob(JOB_UPKEEP, async (_client, job) => {
    try {
      const settings = getSettings(job.guild_id);
      store.prune(job.guild_id, settings.activity.retentionDays, settings.timezone);
      purgeLog.prune(job.guild_id, settings.purge.logRetentionDays);
      const expired = exemptions.pruneExpired();
      const stale = reviews.pruneStale();
      if (expired || stale) log.debug(`Upkeep: ${expired} exemption(s), ${stale} review(s) cleaned.`);
    } finally {
      scheduleUpkeep(job.guild_id, Date.now() + 23 * 60 * 60 * 1000);
    }
  });
}
