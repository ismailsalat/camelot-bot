import { getDb } from '../db/index.js';
import type { GuildSettings } from '../db/settings.js';
import { zonedParts } from '../util/time.js';

/**
 * Daily aggregates only — never message text, never audio. One row per member
 * per local day, plus a per-day record of how much of that day the bot was
 * actually watching.
 */

/** Local calendar day, "YYYY-MM-DD", in the server's timezone. */
export function dayKey(ms: number, timeZone: string): string {
  const parts = zonedParts(ms, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * Step a calendar day key, which is the only safe way to walk days: adding
 * 86,400,000 ms across a daylight-saving change lands on the same local date
 * twice (or skips one), which quietly corrupts a 30-day window.
 */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const stepped = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1));
  stepped.setUTCDate(stepped.getUTCDate() + delta);
  return [
    stepped.getUTCFullYear(),
    String(stepped.getUTCMonth() + 1).padStart(2, '0'),
    String(stepped.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Difference in calendar days between two day keys. */
export function daysBetween(from: string, to: string): number {
  const toUtc = (day: string): number => {
    const [year, month, date] = day.split('-').map(Number);
    return Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** The day keys for the last `count` days, oldest first, ending today. */
export function recentDays(count: number, timeZone: string, now = Date.now()): string[] {
  const today = dayKey(now, timeZone);
  const days: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) days.push(addDays(today, -offset));
  return days;
}

/** A day counts as fully observed once the bot watched most of it. */
export const FULL_COVERAGE_SECONDS = Math.floor(86_400 * 0.8);

export interface DailyRow {
  day: string;
  messages: number;
  voice_seconds: number;
  last_message_at: number;
}

export const store = {
  /** Credit a counted message. Returns false when the cap or cooldown blocks it. */
  countMessage(
    guildId: string,
    userId: string,
    day: string,
    now: number,
    limits: { dailyCap: number; cooldownSeconds: number },
  ): boolean {
    const db = getDb();
    return db.transaction(() => {
      const existing = db
        .prepare(`SELECT messages, last_message_at FROM activity_daily WHERE guild_id = ? AND user_id = ? AND day = ?`)
        .get(guildId, userId, day) as { messages: number; last_message_at: number } | undefined;

      const messages = existing?.messages ?? 0;
      const lastAt = existing?.last_message_at ?? 0;

      if (messages >= limits.dailyCap) return false;
      if (now - lastAt < limits.cooldownSeconds * 1000) return false;

      db.prepare(
        `INSERT INTO activity_daily (guild_id, user_id, day, messages, voice_seconds, last_message_at)
         VALUES (?, ?, ?, 1, 0, ?)
         ON CONFLICT (guild_id, user_id, day) DO UPDATE SET
           messages = messages + 1,
           last_message_at = excluded.last_message_at`,
      ).run(guildId, userId, day, now);
      return true;
    })();
  },

  addVoiceSeconds(guildId: string, userId: string, day: string, seconds: number): void {
    if (seconds <= 0) return;
    getDb()
      .prepare(
        `INSERT INTO activity_daily (guild_id, user_id, day, messages, voice_seconds, last_message_at)
         VALUES (?, ?, ?, 0, ?, 0)
         ON CONFLICT (guild_id, user_id, day) DO UPDATE SET voice_seconds = voice_seconds + excluded.voice_seconds`,
      )
      .run(guildId, userId, day, Math.round(seconds));
  },

  addCoverage(guildId: string, day: string, seconds: number): void {
    if (seconds <= 0) return;
    getDb()
      .prepare(
        `INSERT INTO activity_coverage (guild_id, day, observed_seconds) VALUES (?, ?, ?)
         ON CONFLICT (guild_id, day) DO UPDATE SET observed_seconds = min(86400, observed_seconds + excluded.observed_seconds)`,
      )
      .run(guildId, day, Math.round(seconds));
  },

  /** The first day this server has any record of, or null. */
  firstTrackedDay(guildId: string): string | null {
    const row = getDb()
      .prepare(`SELECT MIN(day) AS day FROM activity_coverage WHERE guild_id = ?`)
      .get(guildId) as { day: string | null } | undefined;
    return row?.day ?? null;
  },

  coverageFor(guildId: string, days: string[]): Map<string, number> {
    if (days.length === 0) return new Map();
    const placeholders = days.map(() => '?').join(',');
    const rows = getDb()
      .prepare(`SELECT day, observed_seconds FROM activity_coverage WHERE guild_id = ? AND day IN (${placeholders})`)
      .all(guildId, ...days) as { day: string; observed_seconds: number }[];
    return new Map(rows.map((row) => [row.day, row.observed_seconds]));
  },

  dailyFor(guildId: string, userId: string, days: string[]): Map<string, DailyRow> {
    if (days.length === 0) return new Map();
    const placeholders = days.map(() => '?').join(',');
    const rows = getDb()
      .prepare(
        `SELECT day, messages, voice_seconds, last_message_at FROM activity_daily
         WHERE guild_id = ? AND user_id = ? AND day IN (${placeholders})`,
      )
      .all(guildId, userId, ...days) as DailyRow[];
    return new Map(rows.map((row) => [row.day, row]));
  },

  /** Everyone with any recorded activity in the window. */
  membersWithActivity(guildId: string, days: string[]): string[] {
    if (days.length === 0) return [];
    const placeholders = days.map(() => '?').join(',');
    return (
      getDb()
        .prepare(
          `SELECT DISTINCT user_id FROM activity_daily WHERE guild_id = ? AND day IN (${placeholders})`,
        )
        .all(guildId, ...days) as { user_id: string }[]
    ).map((row) => row.user_id);
  },

  /** All daily rows for the window, for building a leaderboard in one query. */
  allDailyFor(guildId: string, days: string[]): Map<string, DailyRow[]> {
    if (days.length === 0) return new Map();
    const placeholders = days.map(() => '?').join(',');
    const rows = getDb()
      .prepare(
        `SELECT user_id, day, messages, voice_seconds, last_message_at FROM activity_daily
         WHERE guild_id = ? AND day IN (${placeholders})`,
      )
      .all(guildId, ...days) as (DailyRow & { user_id: string })[];

    const byUser = new Map<string, DailyRow[]>();
    for (const row of rows) {
      const list = byUser.get(row.user_id);
      if (list) list.push(row);
      else byUser.set(row.user_id, [row]);
    }
    return byUser;
  },

  /* ------------------------------ voice sessions --------------------------- */

  openVoice(guildId: string, userId: string, channelId: string, at: number): void {
    getDb()
      .prepare(
        `INSERT INTO voice_sessions (guild_id, user_id, channel_id, started_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
      )
      .run(guildId, userId, channelId, at);
  },

  closeVoice(guildId: string, userId: string): { startedAt: number; channelId: string } | null {
    const db = getDb();
    const row = db
      .prepare(`SELECT channel_id, started_at FROM voice_sessions WHERE guild_id = ? AND user_id = ?`)
      .get(guildId, userId) as { channel_id: string; started_at: number } | undefined;
    if (!row) return null;
    db.prepare(`DELETE FROM voice_sessions WHERE guild_id = ? AND user_id = ?`).run(guildId, userId);
    return { startedAt: row.started_at, channelId: row.channel_id };
  },

  /** Everyone with an open voice session right now. */
  openVoiceUsers(guildId: string): string[] {
    return (
      getDb().prepare(`SELECT user_id FROM voice_sessions WHERE guild_id = ?`).all(guildId) as {
        user_id: string;
      }[]
    ).map((row) => row.user_id);
  },

  /** When a member's current session started, or null. */
  openVoiceSince(guildId: string, userId: string): number | null {
    const row = getDb()
      .prepare(`SELECT started_at FROM voice_sessions WHERE guild_id = ? AND user_id = ?`)
      .get(guildId, userId) as { started_at: number } | undefined;
    return row?.started_at ?? null;
  },

  hasOpenVoice(guildId: string, userId: string): boolean {
    return !!getDb()
      .prepare(`SELECT 1 FROM voice_sessions WHERE guild_id = ? AND user_id = ?`)
      .get(guildId, userId);
  },

  /**
   * Drop every open session without crediting time. Used at boot: we can't
   * know how long the bot was down, and inventing hours is worse than losing
   * a few real ones.
   */
  clearOpenVoice(guildId?: string): number {
    const db = getDb();
    const info = guildId
      ? db.prepare(`DELETE FROM voice_sessions WHERE guild_id = ?`).run(guildId)
      : db.prepare(`DELETE FROM voice_sessions`).run();
    return info.changes;
  },

  /* --------------------------------- upkeep -------------------------------- */

  prune(guildId: string, keepDays: number, timeZone: string, now = Date.now()): void {
    const cutoff = addDays(dayKey(now, timeZone), -keepDays);
    const db = getDb();
    db.prepare(`DELETE FROM activity_daily WHERE guild_id = ? AND day < ?`).run(guildId, cutoff);
    db.prepare(`DELETE FROM activity_coverage WHERE guild_id = ? AND day < ?`).run(guildId, cutoff);
  },

  /** Owner-initiated wipe. Only touches activity data. */
  wipe(guildId: string): void {
    const db = getDb();
    db.prepare(`DELETE FROM activity_daily WHERE guild_id = ?`).run(guildId);
    db.prepare(`DELETE FROM activity_coverage WHERE guild_id = ?`).run(guildId);
    db.prepare(`DELETE FROM voice_sessions WHERE guild_id = ?`).run(guildId);
  },
};

/**
 * Where a message or a voice session actually happened.
 *
 * `parentId` matters more than it looks: a thread's messages belong to the
 * channel above it, and a "join to create" voice channel is made on the fly,
 * so the only stable thing to match it on is its category.
 */
export interface ChannelRef {
  id: string;
  /** Category for a voice channel, parent channel for a thread. */
  parentId: string | null;
}

/** True when the id, or the category it sits in, appears in the list. */
function listed(list: string[], ref: ChannelRef): boolean {
  if (list.includes(ref.id)) return true;
  return ref.parentId !== null && list.includes(ref.parentId);
}

/**
 * Channel eligibility. Two modes, and the exclude list always wins:
 *   all  — everything counts except what you exclude
 *   only — nothing counts except what you include (minus any exclusions)
 *
 * Picking a category includes everything inside it, now and in future, which
 * is what makes dynamically created voice channels work at all.
 */
export function textChannelCounts(
  settings: GuildSettings,
  ref: ChannelRef,
  generalId: string | null,
): boolean {
  if (listed(settings.activity.ignoredChannels, ref)) return false;
  if (settings.activity.textMode === 'all') return true;
  if (settings.activity.textChannels.length > 0) return listed(settings.activity.textChannels, ref);
  // "Only these" with nothing picked yet: fall back to a channel named "general"
  // so a fresh server still records something instead of silently nothing.
  return generalId !== null && (ref.id === generalId || ref.parentId === generalId);
}

export function voiceChannelCounts(
  settings: GuildSettings,
  ref: ChannelRef,
  afkChannelId: string | null,
): boolean {
  if (ref.id === afkChannelId) return false; // AFK never counts, in any mode
  if (listed(settings.activity.ignoredChannels, ref)) return false;
  if (settings.activity.voiceMode === 'all') return true;
  return listed(settings.activity.voiceChannels, ref);
}
