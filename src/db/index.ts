import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { log } from '../logger.js';

let db: Db | undefined;

/** Open (once) and return the SQLite handle. */
export function openDatabase(path: string): Db {
  if (db) return db;
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  log.info(`SQLite ready at ${path}`);
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not opened yet — call openDatabase() first.');
  return db;
}

/** For tests: open an isolated in-memory database. */
export function openTestDatabase(): Db {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  migrate(fresh);
  db = fresh;
  return fresh;
}

const MIGRATIONS: { id: string; sql: string; after?: (db: Db) => void }[] = [
  {
    id: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id   TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id       TEXT NOT NULL,
        channel_id     TEXT NOT NULL,
        message_id     TEXT,
        organizer_id   TEXT NOT NULL,
        game           TEXT NOT NULL,
        start_at       INTEGER NOT NULL,
        status         TEXT NOT NULL DEFAULT 'scheduled',
        vc_channel_id  TEXT,
        vc_reason      TEXT,
        started_at     INTEGER,
        closed_at      INTEGER,
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_guild_status ON sessions (guild_id, status);
      CREATE INDEX IF NOT EXISTS idx_sessions_message ON sessions (message_id);

      CREATE TABLE IF NOT EXISTS session_participants (
        session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        joined_at  INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS session_notices (
        session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        sent_at    INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id, kind)
      );

      CREATE TABLE IF NOT EXISTS clips (
        message_id TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_id  TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        reacted    INTEGER NOT NULL DEFAULT 0,
        deleted    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_clips_guild_time ON clips (guild_id, created_at);

      CREATE TABLE IF NOT EXISTS weekly_winners (
        guild_id   TEXT NOT NULL,
        period_key TEXT NOT NULL,
        message_id TEXT,
        score      INTEGER NOT NULL DEFAULT 0,
        posted_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, period_key)
      );

      CREATE TABLE IF NOT EXISTS game_subscriptions (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        game     TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id, game)
      );

      CREATE TABLE IF NOT EXISTS user_prefs (
        guild_id  TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        muted     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id  TEXT NOT NULL,
        kind      TEXT NOT NULL,
        ref       TEXT NOT NULL,
        run_at    INTEGER NOT NULL,
        payload   TEXT,
        status    TEXT NOT NULL DEFAULT 'pending',
        attempts  INTEGER NOT NULL DEFAULT 0,
        UNIQUE (kind, ref)
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, run_at);

      CREATE TABLE IF NOT EXISTS warn_cooldowns (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        last_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
    `,
  },
  {
    id: '002_emoji_slots_and_games',
    // Remember which emojis a clip was reacted with, so changing the vote
    // emojis later never silently discards votes already cast.
    sql: `
      ALTER TABLE clips ADD COLUMN up_emoji TEXT;
      ALTER TABLE clips ADD COLUMN down_emoji TEXT;
    `,
    after: stampExistingClips,
  },
  {
    id: '003_activity_and_purge',
    // The game panel is gone; its tables go with it. Everything it held was
    // short-lived session state with no value once the feature is removed.
    sql: `
      DROP TABLE IF EXISTS session_notices;
      DROP TABLE IF EXISTS session_participants;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS game_subscriptions;
      DROP TABLE IF EXISTS user_prefs;
      DELETE FROM jobs WHERE kind LIKE 'session.%';

      -- One row per member per local day. Message text is never stored.
      CREATE TABLE IF NOT EXISTS activity_daily (
        guild_id      TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        day           TEXT NOT NULL,
        messages      INTEGER NOT NULL DEFAULT 0,
        voice_seconds INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_daily_day ON activity_daily (guild_id, day);

      -- How much of each day the bot was actually watching, so an outage is
      -- never mistaken for someone being inactive.
      CREATE TABLE IF NOT EXISTS activity_coverage (
        guild_id        TEXT NOT NULL,
        day             TEXT NOT NULL,
        observed_seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, day)
      );

      -- Open voice sessions, so a restart can reconcile instead of inventing hours.
      CREATE TABLE IF NOT EXISTS voice_sessions (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS member_exemptions (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        until    INTEGER NOT NULL,
        note     TEXT,
        set_by   TEXT NOT NULL,
        set_at   INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS purge_sessions (
        id         TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        actor_id   TEXT NOT NULL,
        scope      TEXT NOT NULL,
        candidates TEXT NOT NULL,
        cursor     INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS purge_decisions (
        session_id TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        decision   TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS purge_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id  TEXT NOT NULL,
        actor_id  TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        at        INTEGER NOT NULL,
        reason    TEXT,
        success   INTEGER NOT NULL,
        detail    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_purge_log_guild ON purge_log (guild_id, at);
    `,
  },
  {
    id: '004_app_meta',
    sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

/**
 * A tiny key-value store for facts about this deployment rather than about a
 * server — currently just the shape of the slash commands last published, so
 * boot can tell whether Discord needs telling about a new one.
 */
export const meta = {
  get(key: string): string | null {
    const row = getDb().prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  },
  set(key: string, value: string): void {
    getDb()
      .prepare(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  },
};

/**
 * Clips recorded before the emoji slots existed were reacted with the old
 * defaults. Record those so votes already cast keep counting.
 */
function stampExistingClips(handle: Db): void {
  handle.prepare(`UPDATE clips SET up_emoji = ?, down_emoji = ? WHERE up_emoji IS NULL`).run('👍', '👎');
}

function migrate(handle: Db): void {
  handle.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`);
  const applied = new Set(
    handle.prepare(`SELECT id FROM _migrations`).all().map((row) => (row as { id: string }).id),
  );
  const insert = handle.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`);
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    handle.transaction(() => {
      handle.exec(migration.sql);
      migration.after?.(handle);
      insert.run(migration.id, Date.now());
    })();
    log.info(`Applied migration ${migration.id}`);
  }
}
