import type { GuildSettings } from '../db/settings.js';
import { FULL_COVERAGE_SECONDS, daysBetween, recentDays, store, type DailyRow } from './store.js';
import {
  activityScore,
  displayPercent,
  displayScore,
  inactivityProbability,
  trend,
  type TrendResult,
} from './model.js';
import type { DayState } from '../core/ui.js';

export const WINDOW_DAYS = 30;

export interface MemberSummary {
  userId: string;
  /** Raw eligible voice time — what actually happened. */
  voiceSeconds: number;
  /** After the daily cap — what the score uses. */
  scoredVoiceSeconds: number;
  messages: number;
  activeDays: number;
  /** Days in the window the bot watched end to end. */
  observedDays: number;
  /** null when there has never been any qualifying activity. */
  lastActiveDay: string | null;
  daysSinceActive: number | null;
  score: number;
  inactivityPercent: number;
  trend: TrendResult;
  timeline: DayState[];
  /** True when there isn't enough observation to take the numbers seriously. */
  provisional: boolean;
}

function isActiveDay(row: DailyRow | undefined, settings: GuildSettings): boolean {
  if (!row) return false;
  const voiceMinutes = row.voice_seconds / 60;
  return (
    voiceMinutes >= settings.activity.activeDayVoiceMinutes ||
    row.messages >= settings.activity.activeDayMessages
  );
}

/** Everything the UI and The Purge need about one member, in one pass. */
export function summarise(
  guildId: string,
  userId: string,
  settings: GuildSettings,
  now = Date.now(),
  preloaded?: { daily: Map<string, DailyRow>; coverage: Map<string, number> },
): MemberSummary {
  const days = recentDays(WINDOW_DAYS, settings.timezone, now);
  const daily = preloaded?.daily ?? store.dailyFor(guildId, userId, days);
  const coverage = preloaded?.coverage ?? store.coverageFor(guildId, days);

  const voiceCapSeconds = settings.activity.dailyVoiceCapMinutes * 60;
  const today = days[days.length - 1];

  let voiceSeconds = 0;
  let scoredVoiceSeconds = 0;
  let messages = 0;
  let activeDays = 0;
  let observedDays = 0;
  let lastActiveDay: string | null = null;

  const timeline: DayState[] = [];

  for (const day of days) {
    const row = daily.get(day);
    const seconds = coverage.get(day) ?? 0;
    // Today is always partial, so it never counts toward the observed total —
    // but it is being watched right now, which is not the same as untracked.
    const fullyObserved = seconds >= FULL_COVERAGE_SECONDS && day !== today;
    const watching = day === today && seconds > 0;
    if (fullyObserved) observedDays += 1;

    voiceSeconds += row?.voice_seconds ?? 0;
    scoredVoiceSeconds += Math.min(row?.voice_seconds ?? 0, voiceCapSeconds);
    messages += row?.messages ?? 0;

    const active = isActiveDay(row, settings);
    if (active) {
      activeDays += 1;
      lastActiveDay = day;
    }

    timeline.push(active ? 'active' : fullyObserved || watching ? 'idle' : 'unknown');
  }

  const daysSinceActive = lastActiveDay === null || !today ? null : daysBetween(lastActiveDay, today);

  const breakdown = activityScore({
    activeDays,
    scoredVoiceSeconds,
    countedMessages: messages,
    daysSinceActive,
  });

  const probability = inactivityProbability({ activeDays, observedDays });

  // Trend: the last 7 days against the 7 before them.
  const window = (slice: string[]) => {
    let windowMessages = 0;
    let windowVoice = 0;
    let windowObserved = 0;
    for (const day of slice) {
      const row = daily.get(day);
      windowMessages += row?.messages ?? 0;
      windowVoice += Math.min(row?.voice_seconds ?? 0, voiceCapSeconds);
      if ((coverage.get(day) ?? 0) >= FULL_COVERAGE_SECONDS && day !== today) windowObserved += 1;
    }
    return { messages: windowMessages, voiceSeconds: windowVoice, observedDays: windowObserved };
  };

  const recent = days.slice(-8, -1); // the 7 full days before today
  const previous = days.slice(-15, -8);

  return {
    userId,
    voiceSeconds,
    scoredVoiceSeconds,
    messages,
    activeDays,
    observedDays,
    lastActiveDay,
    daysSinceActive,
    score: displayScore(breakdown.score),
    inactivityPercent: displayPercent(probability),
    trend: trend(window(recent), window(previous)),
    timeline,
    provisional: observedDays < settings.purge.minObservedDays,
  };
}

/** Summaries for many members without a query per person. */
export function summariseMany(
  guildId: string,
  userIds: string[],
  settings: GuildSettings,
  now = Date.now(),
): MemberSummary[] {
  const days = recentDays(WINDOW_DAYS, settings.timezone, now);
  const coverage = store.coverageFor(guildId, days);
  const byUser = store.allDailyFor(guildId, days);

  return userIds.map((userId) => {
    const rows = byUser.get(userId) ?? [];
    const daily = new Map(rows.map((row) => [row.day, row]));
    return summarise(guildId, userId, settings, now, { daily, coverage });
  });
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatLastActive(summary: MemberSummary): string {
  if (summary.daysSinceActive === null) return 'Not yet';
  if (summary.daysSinceActive === 0) return 'Today';
  if (summary.daysSinceActive === 1) return 'Yesterday';
  return `${summary.daysSinceActive} days ago`;
}
