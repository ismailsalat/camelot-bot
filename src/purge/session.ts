import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import type { Scope } from './policy.js';

/**
 * A review session is a bounded snapshot: the candidate list is decided once,
 * so swiping never re-queries, and decisions survive a restart or an expired
 * interaction token.
 */

export type Decision = 'keep' | 'purge' | 'skip';

export interface ReviewSession {
  id: string;
  guildId: string;
  actorId: string;
  scope: Scope;
  /** User ids, in review order. */
  candidates: string[];
  cursor: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  id: string;
  guild_id: string;
  actor_id: string;
  scope: string;
  candidates: string;
  cursor: number;
  created_at: number;
  updated_at: number;
}

function hydrate(row: SessionRow): ReviewSession {
  let candidates: string[] = [];
  try {
    const parsed = JSON.parse(row.candidates);
    if (Array.isArray(parsed)) candidates = parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    candidates = [];
  }
  return {
    id: row.id,
    guildId: row.guild_id,
    actorId: row.actor_id,
    scope: row.scope as Scope,
    candidates,
    cursor: row.cursor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Sessions older than this are stale and get cleaned up. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const reviews = {
  /** One live session per admin per guild — starting again replaces the old one. */
  start(guildId: string, actorId: string, scope: Scope, candidates: string[]): ReviewSession {
    const db = getDb();
    const id = randomUUID();
    const now = Date.now();

    db.transaction(() => {
      const previous = db
        .prepare(`SELECT id FROM purge_sessions WHERE guild_id = ? AND actor_id = ?`)
        .all(guildId, actorId) as { id: string }[];
      for (const row of previous) {
        db.prepare(`DELETE FROM purge_decisions WHERE session_id = ?`).run(row.id);
        db.prepare(`DELETE FROM purge_sessions WHERE id = ?`).run(row.id);
      }
      db.prepare(
        `INSERT INTO purge_sessions (id, guild_id, actor_id, scope, candidates, cursor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(id, guildId, actorId, scope, JSON.stringify(candidates), now, now);
    })();

    return reviews.get(id)!;
  },

  get(id: string): ReviewSession | null {
    const row = getDb().prepare(`SELECT * FROM purge_sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row ? hydrate(row) : null;
  },

  findFor(guildId: string, actorId: string): ReviewSession | null {
    const row = getDb()
      .prepare(`SELECT * FROM purge_sessions WHERE guild_id = ? AND actor_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(guildId, actorId) as SessionRow | undefined;
    return row ? hydrate(row) : null;
  },

  setCursor(id: string, cursor: number): void {
    getDb()
      .prepare(`UPDATE purge_sessions SET cursor = ?, updated_at = ? WHERE id = ?`)
      .run(Math.max(0, cursor), Date.now(), id);
  },

  decide(id: string, userId: string, decision: Decision): void {
    getDb()
      .prepare(
        `INSERT INTO purge_decisions (session_id, user_id, decision, decided_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id, user_id) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`,
      )
      .run(id, userId, decision, Date.now());
  },

  decisions(id: string): Map<string, Decision> {
    const rows = getDb().prepare(`SELECT user_id, decision FROM purge_decisions WHERE session_id = ?`).all(id) as {
      user_id: string;
      decision: Decision;
    }[];
    return new Map(rows.map((row) => [row.user_id, row.decision]));
  },

  tally(id: string): { keep: number; purge: number; skipped: number; reviewed: number; total: number } {
    const session = reviews.get(id);
    const decisions = reviews.decisions(id);
    let keep = 0;
    let purge = 0;
    for (const decision of decisions.values()) {
      if (decision === 'keep') keep += 1;
      else if (decision === 'purge') purge += 1;
    }
    const total = session?.candidates.length ?? 0;
    const decided = keep + purge;
    return { keep, purge, skipped: Math.max(0, total - decided), reviewed: decisions.size, total };
  },

  queued(id: string): string[] {
    const session = reviews.get(id);
    if (!session) return [];
    const decisions = reviews.decisions(id);
    // Keep the review order so the confirmation list reads the same way.
    return session.candidates.filter((userId) => decisions.get(userId) === 'purge');
  },

  finish(id: string): void {
    const db = getDb();
    db.transaction(() => {
      db.prepare(`DELETE FROM purge_decisions WHERE session_id = ?`).run(id);
      db.prepare(`DELETE FROM purge_sessions WHERE id = ?`).run(id);
    })();
  },

  /** Drop abandoned sessions so the table stays small. */
  pruneStale(now = Date.now()): number {
    const db = getDb();
    const cutoff = now - SESSION_TTL_MS;
    const stale = db.prepare(`SELECT id FROM purge_sessions WHERE updated_at < ?`).all(cutoff) as { id: string }[];
    for (const row of stale) {
      db.prepare(`DELETE FROM purge_decisions WHERE session_id = ?`).run(row.id);
      db.prepare(`DELETE FROM purge_sessions WHERE id = ?`).run(row.id);
    }
    return stale.length;
  },
};

/* --------------------------------- logging --------------------------------- */

export const purgeLog = {
  record(entry: {
    guildId: string;
    actorId: string;
    userId: string;
    reason: string;
    success: boolean;
    detail?: string;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO purge_log (guild_id, actor_id, user_id, at, reason, success, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.guildId,
        entry.actorId,
        entry.userId,
        Date.now(),
        entry.reason,
        entry.success ? 1 : 0,
        entry.detail ?? null,
      );
  },

  recent(guildId: string, limit = 20): {
    actorId: string;
    userId: string;
    at: number;
    success: boolean;
    detail: string | null;
  }[] {
    return (
      getDb()
        .prepare(
          `SELECT actor_id, user_id, at, success, detail FROM purge_log WHERE guild_id = ? ORDER BY at DESC LIMIT ?`,
        )
        .all(guildId, limit) as {
        actor_id: string;
        user_id: string;
        at: number;
        success: number;
        detail: string | null;
      }[]
    ).map((row) => ({
      actorId: row.actor_id,
      userId: row.user_id,
      at: row.at,
      success: row.success === 1,
      detail: row.detail,
    }));
  },

  prune(guildId: string, keepDays: number, now = Date.now()): void {
    getDb()
      .prepare(`DELETE FROM purge_log WHERE guild_id = ? AND at < ?`)
      .run(guildId, now - keepDays * 86_400_000);
  },
};
