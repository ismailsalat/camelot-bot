import type { Client } from 'discord.js';
import { getDb } from './db/index.js';
import { log } from './logger.js';

export interface JobRow {
  id: number;
  guild_id: string;
  kind: string;
  ref: string;
  run_at: number;
  payload: string | null;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
}

export type JobHandler = (client: Client, job: JobRow) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

/**
 * Queue a job. `ref` makes it idempotent: re-queuing the same (kind, ref)
 * reschedules instead of creating a duplicate, which is what keeps a restart
 * from firing the same session start twice.
 */
export function schedule(input: {
  guildId: string;
  kind: string;
  ref: string;
  runAt: number;
  payload?: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT INTO jobs (guild_id, kind, ref, run_at, payload, status, attempts)
       VALUES (?, ?, ?, ?, ?, 'pending', 0)
       ON CONFLICT (kind, ref) DO UPDATE SET
         run_at = excluded.run_at,
         payload = excluded.payload,
         status = 'pending',
         attempts = 0`,
    )
    .run(
      input.guildId,
      input.kind,
      input.ref,
      Math.round(input.runAt),
      input.payload === undefined ? null : JSON.stringify(input.payload),
    );
}

export function cancel(kind: string, ref: string): void {
  getDb().prepare(`DELETE FROM jobs WHERE kind = ? AND ref = ?`).run(kind, ref);
}

const MAX_ATTEMPTS = 3;
let timer: NodeJS.Timeout | undefined;
let running = false;

export function startScheduler(client: Client, tickMs = 15_000): void {
  if (timer) return;
  const tick = () => {
    void runDueJobs(client);
  };
  timer = setInterval(tick, tickMs);
  if (typeof timer.unref === 'function') timer.unref();
  tick(); // catch up on anything that came due while the bot was offline
  log.info(`Scheduler started (tick ${tickMs}ms)`);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function runDueJobs(client: Client, now = Date.now()): Promise<void> {
  if (running) return; // never overlap ticks
  running = true;
  try {
    const db = getDb();
    const due = db
      .prepare(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 50`)
      .all(now) as JobRow[];

    for (const job of due) {
      const handler = handlers.get(job.kind);
      if (!handler) {
        log.warn(`No handler for job kind "${job.kind}" — dropping job ${job.id}`);
        db.prepare(`DELETE FROM jobs WHERE id = ?`).run(job.id);
        continue;
      }
      // Claim the row first so a slow handler can't be started twice.
      const claimed = db
        .prepare(`UPDATE jobs SET status = 'done', attempts = attempts + 1 WHERE id = ? AND status = 'pending'`)
        .run(job.id);
      if (claimed.changes === 0) continue;

      try {
        await handler(client, job);
        db.prepare(`DELETE FROM jobs WHERE id = ?`).run(job.id);
      } catch (error) {
        const attempts = job.attempts + 1;
        log.error(`Job ${job.kind}/${job.ref} failed (attempt ${attempts})`, error);
        if (attempts >= MAX_ATTEMPTS) {
          db.prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(job.id);
        } else {
          db.prepare(`UPDATE jobs SET status = 'pending', run_at = ? WHERE id = ?`).run(
            Date.now() + 30_000 * attempts,
            job.id,
          );
        }
      }
    }
  } catch (error) {
    log.error('Scheduler tick failed', error);
  } finally {
    running = false;
  }
}
