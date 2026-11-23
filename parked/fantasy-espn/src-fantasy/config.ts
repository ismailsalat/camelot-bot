import { getDb } from '../db/index.js';
import { seasonLabel } from './domain.js';

/**
 * Fantasy settings live in their own table, not in guild_settings, so the whole
 * module can be removed with a few DROP TABLEs and nothing else is touched.
 */

export type ModuleStatus = 'setup' | 'active' | 'archived';

export interface FantasyConfig {
  enabled: boolean;
  status: ModuleStatus;

  /** Camelot's own season counter — unrelated to ESPN's season id. */
  camelotSeason: number;
  espnSeasonId: number;
  leagueId: string;

  channels: {
    dashboard: string | null;
    /** Where announcements go. Falls back to the dashboard channel. */
    announcements: string | null;
    /** Optional #general cross-post, off by default. */
    general: string | null;
  };

  dashboardMessageId: string | null;

  roles: {
    /** May configure the module and link members. Admins always can. */
    manage: string[];
    /** May share a card publicly and pin it. */
    share: string[];
  };

  notifications: {
    trades: boolean;
    weeklyRecap: boolean;
    finalResults: boolean;
    crossPostToGeneral: boolean;
  };

  /** Minutes between ESPN polls, while games are on and while they aren't. */
  pollActiveMinutes: number;
  pollIdleMinutes: number;

  /**
   * Anything ESPN recorded before this is treated as history, so enabling the
   * module never spams the channel with months of old trades.
   */
  baselineAt: number | null;
}

export const DEFAULT_FANTASY_CONFIG: FantasyConfig = {
  enabled: false,
  status: 'setup',
  camelotSeason: 1,
  espnSeasonId: 2027,
  leagueId: '',
  channels: { dashboard: null, announcements: null, general: null },
  dashboardMessageId: null,
  roles: { manage: [], share: [] },
  notifications: { trades: true, weeklyRecap: true, finalResults: true, crossPostToGeneral: false },
  pollActiveMinutes: 10,
  pollIdleMinutes: 60,
  baselineAt: null,
};

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge<T>(base: T, stored: unknown): T {
  if (!isPlainObject(stored) || !isPlainObject(base)) return base;
  const out: Plain = { ...(base as unknown as Plain) };
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in out)) continue;
    const baseValue = out[key];
    out[key] = isPlainObject(baseValue) && isPlainObject(value) ? merge(baseValue, value) : value;
  }
  return out as unknown as T;
}

const cache = new Map<string, FantasyConfig>();

export function getFantasyConfig(guildId: string): FantasyConfig {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const row = getDb().prepare(`SELECT data FROM fantasy_config WHERE guild_id = ?`).get(guildId) as
    | { data: string }
    | undefined;

  let parsed: unknown = {};
  if (row) {
    try {
      parsed = JSON.parse(row.data);
    } catch {
      parsed = {};
    }
  }
  const merged = merge(DEFAULT_FANTASY_CONFIG, parsed);
  cache.set(guildId, merged);
  return merged;
}

export function saveFantasyConfig(guildId: string, next: FantasyConfig): FantasyConfig {
  getDb()
    .prepare(
      `INSERT INTO fantasy_config (guild_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .run(guildId, JSON.stringify(next), Date.now());
  cache.set(guildId, next);
  return next;
}

export function updateFantasyConfig(guildId: string, patch: Plain): FantasyConfig {
  return saveFantasyConfig(guildId, merge(getFantasyConfig(guildId), patch));
}

export function clearFantasyCache(guildId?: string): void {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

/** Guilds with the module switched on — what the scheduler iterates. */
export function activeFantasyGuilds(): string[] {
  const rows = getDb().prepare(`SELECT guild_id, data FROM fantasy_config`).all() as {
    guild_id: string;
    data: string;
  }[];
  return rows
    .filter((row) => {
      try {
        return JSON.parse(row.data).enabled === true;
      } catch {
        return false;
      }
    })
    .map((row) => row.guild_id);
}

export function announcementsChannelId(config: FantasyConfig): string | null {
  return config.channels.announcements ?? config.channels.dashboard;
}

/** "Camelot Fantasy Basketball — Season 01" */
export function seasonTitle(config: FantasyConfig): string {
  return `Season ${String(config.camelotSeason).padStart(2, '0')}`;
}

export function nbaSeasonLabel(config: FantasyConfig): string {
  return seasonLabel(config.espnSeasonId);
}
