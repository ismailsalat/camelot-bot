import { getDb } from './index.js';

/* --------------------------------- sessions -------------------------------- */

export type SessionStatus = 'scheduled' | 'live' | 'closed' | 'cancelled';

export interface SessionRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  organizer_id: string;
  /** Display name, as shown to members. */
  game: string;
  /** Stable id from settings.games.list — what subscriptions match on. */
  game_id: string | null;
  start_at: number;
  status: SessionStatus;
  vc_channel_id: string | null;
  vc_reason: string | null;
  started_at: number | null;
  closed_at: number | null;
  created_at: number;
}

export const sessions = {
  create(input: {
    guildId: string;
    channelId: string;
    organizerId: string;
    game: string;
    gameId: string;
    startAt: number;
  }): SessionRow {
    const db = getDb();
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO sessions (guild_id, channel_id, organizer_id, game, game_id, start_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      )
      .run(input.guildId, input.channelId, input.organizerId, input.game, input.gameId, input.startAt, now);
    const id = Number(info.lastInsertRowid);
    db.prepare(`INSERT OR IGNORE INTO session_participants (session_id, user_id, joined_at) VALUES (?, ?, ?)`).run(
      id,
      input.organizerId,
      now,
    );
    return sessions.byId(id)!;
  },

  byId(id: number): SessionRow | undefined {
    return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  },

  byMessageId(messageId: string): SessionRow | undefined {
    return getDb().prepare(`SELECT * FROM sessions WHERE message_id = ?`).get(messageId) as SessionRow | undefined;
  },

  setMessageId(id: number, messageId: string): void {
    getDb().prepare(`UPDATE sessions SET message_id = ? WHERE id = ?`).run(messageId, id);
  },

  setVoice(id: number, channelId: string | null, reason: string): void {
    getDb().prepare(`UPDATE sessions SET vc_channel_id = ?, vc_reason = ? WHERE id = ?`).run(channelId, reason, id);
  },

  markLive(id: number): boolean {
    // Only transitions once — guards against a duplicate scheduler run.
    const info = getDb()
      .prepare(`UPDATE sessions SET status = 'live', started_at = ? WHERE id = ? AND status = 'scheduled'`)
      .run(Date.now(), id);
    return info.changes > 0;
  },

  close(id: number, status: Extract<SessionStatus, 'closed' | 'cancelled'> = 'closed'): boolean {
    const info = getDb()
      .prepare(`UPDATE sessions SET status = ?, closed_at = ? WHERE id = ? AND status IN ('scheduled','live')`)
      .run(status, Date.now(), id);
    return info.changes > 0;
  },

  /** Sessions that are still scheduled or live (used by the VC picker + boot recovery). */
  active(guildId: string): SessionRow[] {
    return getDb()
      .prepare(`SELECT * FROM sessions WHERE guild_id = ? AND status IN ('scheduled','live') ORDER BY start_at`)
      .all(guildId) as SessionRow[];
  },

  allActive(): SessionRow[] {
    return getDb().prepare(`SELECT * FROM sessions WHERE status IN ('scheduled','live')`).all() as SessionRow[];
  },

  participants(id: number): string[] {
    return (
      getDb()
        .prepare(
          // rowid breaks ties so two people joining in the same millisecond keep
          // a stable order, with the organizer first.
          `SELECT user_id FROM session_participants WHERE session_id = ? ORDER BY joined_at, rowid`,
        )
        .all(id) as {
        user_id: string;
      }[]
    ).map((row) => row.user_id);
  },

  isParticipant(id: number, userId: string): boolean {
    return !!getDb()
      .prepare(`SELECT 1 FROM session_participants WHERE session_id = ? AND user_id = ?`)
      .get(id, userId);
  },

  /** Returns the new membership state. Safe against double clicks. */
  toggleParticipant(id: number, userId: string): 'joined' | 'left' {
    const db = getDb();
    return db.transaction(() => {
      const existing = db
        .prepare(`SELECT 1 FROM session_participants WHERE session_id = ? AND user_id = ?`)
        .get(id, userId);
      if (existing) {
        db.prepare(`DELETE FROM session_participants WHERE session_id = ? AND user_id = ?`).run(id, userId);
        return 'left' as const;
      }
      db.prepare(`INSERT OR IGNORE INTO session_participants (session_id, user_id, joined_at) VALUES (?, ?, ?)`).run(
        id,
        userId,
        Date.now(),
      );
      return 'joined' as const;
    })();
  },

  /** Record that a one-off notice was sent. False if it was already sent. */
  markNotice(sessionId: number, userId: string, kind: string): boolean {
    const info = getDb()
      .prepare(`INSERT OR IGNORE INTO session_notices (session_id, user_id, kind, sent_at) VALUES (?, ?, ?, ?)`)
      .run(sessionId, userId, kind, Date.now());
    return info.changes > 0;
  },
};

/* ----------------------------------- clips --------------------------------- */

export interface ClipRow {
  message_id: string;
  guild_id: string;
  channel_id: string;
  author_id: string;
  created_at: number;
  reacted: number;
  deleted: number;
  /** Emojis this clip was actually reacted with (null for pre-v2 rows). */
  up_emoji: string | null;
  down_emoji: string | null;
}

export const clips = {
  /** Returns false if this clip was already recorded (so we never double-react). */
  record(input: {
    messageId: string;
    guildId: string;
    channelId: string;
    authorId: string;
    createdAt: number;
  }): boolean {
    const info = getDb()
      .prepare(
        `INSERT OR IGNORE INTO clips (message_id, guild_id, channel_id, author_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.messageId, input.guildId, input.channelId, input.authorId, input.createdAt);
    return info.changes > 0;
  },

  markReacted(messageId: string, upEmoji: string, downEmoji: string): void {
    getDb()
      .prepare(`UPDATE clips SET reacted = 1, up_emoji = ?, down_emoji = ? WHERE message_id = ?`)
      .run(upEmoji, downEmoji, messageId);
  },

  markDeleted(messageId: string): void {
    getDb().prepare(`UPDATE clips SET deleted = 1 WHERE message_id = ?`).run(messageId);
  },

  byId(messageId: string): ClipRow | undefined {
    return getDb().prepare(`SELECT * FROM clips WHERE message_id = ?`).get(messageId) as ClipRow | undefined;
  },

  inWindow(guildId: string, fromMs: number, toMs: number): ClipRow[] {
    return getDb()
      .prepare(
        `SELECT * FROM clips
         WHERE guild_id = ? AND deleted = 0 AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC`,
      )
      .all(guildId, fromMs, toMs) as ClipRow[];
  },
};

/* ------------------------------ weekly winners ----------------------------- */

export const weekly = {
  /** True if this period had not been announced yet (restart-safe). */
  claim(guildId: string, periodKey: string, messageId: string | null, score: number): boolean {
    const info = getDb()
      .prepare(
        `INSERT OR IGNORE INTO weekly_winners (guild_id, period_key, message_id, score, posted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(guildId, periodKey, messageId, score, Date.now());
    return info.changes > 0;
  },
  wasAnnounced(guildId: string, periodKey: string): boolean {
    return !!getDb()
      .prepare(`SELECT 1 FROM weekly_winners WHERE guild_id = ? AND period_key = ?`)
      .get(guildId, periodKey);
  },
};

/* ------------------------------ subscriptions ------------------------------ */

export const subs = {
  list(guildId: string, userId: string): string[] {
    return (
      getDb()
        .prepare(`SELECT game FROM game_subscriptions WHERE guild_id = ? AND user_id = ?`)
        .all(guildId, userId) as { game: string }[]
    ).map((row) => row.game);
  },

  set(guildId: string, userId: string, games: string[]): void {
    const db = getDb();
    db.transaction(() => {
      db.prepare(`DELETE FROM game_subscriptions WHERE guild_id = ? AND user_id = ?`).run(guildId, userId);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO game_subscriptions (guild_id, user_id, game) VALUES (?, ?, ?)`,
      );
      for (const game of games) insert.run(guildId, userId, game);
    })();
  },

  subscribers(guildId: string, game: string): string[] {
    return (
      getDb()
        .prepare(`SELECT user_id FROM game_subscriptions WHERE guild_id = ? AND game = ?`)
        .all(guildId, game) as { user_id: string }[]
    ).map((row) => row.user_id);
  },

  isMuted(guildId: string, userId: string): boolean {
    const row = getDb()
      .prepare(`SELECT muted FROM user_prefs WHERE guild_id = ? AND user_id = ?`)
      .get(guildId, userId) as { muted: number } | undefined;
    return !!row?.muted;
  },

  setMuted(guildId: string, userId: string, muted: boolean): void {
    getDb()
      .prepare(
        `INSERT INTO user_prefs (guild_id, user_id, muted) VALUES (?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET muted = excluded.muted`,
      )
      .run(guildId, userId, muted ? 1 : 0);
  },
};

/* ------------------------------ warn cooldowns ----------------------------- */

export const cooldowns = {
  /** True if a warning may be sent now; records the attempt when it returns true. */
  take(guildId: string, userId: string, windowMs: number): boolean {
    const db = getDb();
    const now = Date.now();
    const row = db
      .prepare(`SELECT last_at FROM warn_cooldowns WHERE guild_id = ? AND user_id = ?`)
      .get(guildId, userId) as { last_at: number } | undefined;
    if (row && now - row.last_at < windowMs) return false;
    db.prepare(
      `INSERT INTO warn_cooldowns (guild_id, user_id, last_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET last_at = excluded.last_at`,
    ).run(guildId, userId, now);
    return true;
  },
};
