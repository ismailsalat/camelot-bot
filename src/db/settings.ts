import { getDb } from './index.js';

/* ---------------------------------------------------------------------------
 * One settings object per server. Only values an admin actually changed are
 * written, so improved defaults still reach servers that never touched them.
 * ------------------------------------------------------------------------- */

export const EMOJI_SLOTS = [
  'sword',
  'crown',
  'tv',
  'check',
  'x',
  'owner',
  'star',
  'thumbsUp',
  'thumbsDown',
  'shield',
  // Status markers — these carry meaning, so they earn their place.
  'live',
  'idle',
  'quiet',
  'purge',
] as const;

export type EmojiSlot = (typeof EMOJI_SLOTS)[number];

export const EMOJI_FALLBACKS: Record<EmojiSlot, string> = {
  sword: '⚔️',
  crown: '👑',
  tv: '📺',
  check: '✅',
  x: '✖️',
  owner: '👤',
  star: '⭐',
  thumbsUp: '👍',
  thumbsDown: '👎',
  shield: '🛡️',
  live: '🟢',
  idle: '🟡',
  quiet: '💤',
  purge: '🚨',
};

/** Emoji names Camelot will adopt on sight, per slot. Case-insensitive. */
export const EMOJI_ADOPT_NAMES: Record<EmojiSlot, string[]> = {
  sword: ['z_sword', 'sword'],
  crown: ['z_crown', 'crown'],
  tv: ['z_tv', 'tv'],
  check: ['z_check', 'check', 'yes', 'tick'],
  x: ['z_x', 'cross', 'no'],
  owner: ['z_owner', 'owner'],
  star: ['z_star', 'star'],
  thumbsUp: ['z_thumbsup', 'thumbsup', 'upvote'],
  thumbsDown: ['z_thumbsdown', 'thumbsdown', 'downvote'],
  shield: ['z_shield', 'shield'],
  live: ['z_online', 'z_live', 'online', 'live', 'green'],
  idle: ['z_idle', 'idle', 'away', 'yellow'],
  quiet: ['z_zzz', 'z_quiet', 'zzz', 'sleeping', 'sleep', 'quiet'],
  purge: ['z_purge', 'purge', 'siren', 'alert', 'alarm'],
};

export const EMOJI_LABELS: Record<EmojiSlot, string> = {
  sword: 'Sword — Camelot signature',
  crown: 'Crown — headings',
  tv: 'TV — clips and media',
  check: 'Check — keep, done',
  x: 'X — purge, cancel',
  owner: 'Owner — server owner',
  star: 'Star — Clip of the Week',
  thumbsUp: 'Thumbs up — clip votes',
  thumbsDown: 'Thumbs down — clip votes',
  shield: 'Shield — protected members',
  live: 'Online — counting right now',
  idle: 'Idle — in voice, not counting',
  quiet: 'Sleeping — gone quiet for a while',
  purge: 'Siren — the review screen',
};

/** How a channel list is read. */
export type ChannelMode = 'all' | 'only';

export interface WarningSettings {
  mode: 'channel' | 'dm' | 'silent';
  text: string;
  deleteAfterSeconds: number;
  pingAuthor: boolean;
  cooldownSeconds: number;
  dmAutoDelete: boolean;
}

/** Ordered by priority: the first matching policy decides. They never stack. */
export interface RolePolicy {
  roleId: string;
  effect: 'protect' | 'normal';
}

export interface GuildSettings {
  timezone: string;

  core: {
    /**
     * Prefix for text commands in this server. `null` means "whatever
     * COMMAND_PREFIX says", so a server that never sets one follows the host.
     */
    prefix: string | null;
    /** Text commands can be switched off entirely, leaving only slash commands. */
    textCommands: boolean;
  };

  /** Core is always on and is not listed here. */
  modules: {
    clips: boolean;
    activity: boolean;
    purge: boolean;
  };

  channels: {
    clips: string | null;
    /** Where the weekly winner goes. Falls back to the clips channel. */
    highlights: string | null;
  };

  emojis: Record<EmojiSlot, string>;

  permissions: {
    /** Roles treated as Camelot admins on top of Discord's Manage Server. */
    adminRoles: string[];
    /** Setting groups admins may change. The owner can always change everything. */
    adminEditable: string[];
  };

  media: {
    allowImages: boolean;
    allowVideos: boolean;
    allowAudio: boolean;
    allowStickers: boolean;
    providers: string[];
    blockedProviders: string[];
    graceMs: number;
    bypassRoles: string[];
    bypassModerators: boolean;
    warning: WarningSettings;
  };

  voting: {
    exclusive: boolean;
    countAuthorVote: boolean;
    downvotesSubtract: boolean;
  };

  weekly: {
    dayOfWeek: number;
    time: string;
    title: string;
    minVotes: number;
    announceNoWinner: boolean;
  };

  activity: {
    enabled: boolean;
    /**
     * 'all'  — every channel counts, except the ones you exclude.
     * 'only' — nothing counts, except the ones you include.
     */
    textMode: ChannelMode;
    voiceMode: ChannelMode;
    /** Used when the matching mode is 'only'. */
    textChannels: string[];
    voiceChannels: string[];
    /** Used when the matching mode is 'all'. Always wins either way. */
    ignoredChannels: string[];
    /** Most messages that can count toward one day. */
    dailyMessageCap: number;
    /** Gap needed when nobody else is talking. */
    messageCooldownSeconds: number;
    /** Gap needed mid-conversation — short, because debates are fast. */
    activeCooldownSeconds: number;
    /** Shorter messages don't count. */
    minMessageLength: number;
    /** A day is active at this much voice time… */
    activeDayVoiceMinutes: number;
    /** …or this many counted messages. */
    activeDayMessages: number;
    /** Voice time that can count toward one day. */
    dailyVoiceCapMinutes: number;
    /** New members aren't reviewed for this long. */
    gracePeriodDays: number;
    /** Daily summaries older than this are cleaned up. */
    retentionDays: number;
  };

  purge: {
    /** Priority order. First match wins; policies never stack. */
    rolePolicies: RolePolicy[];
    /** Any of these means the member can never be purged. Overrides everything. */
    absoluteRoles: string[];
    /** No qualifying activity for this long makes someone a candidate. */
    inactivityDays: number;
    /** Don't judge anyone until tracking has this many fully observed days. */
    minObservedDays: number;
    /** How long removal logs are kept. */
    logRetentionDays: number;
  };
}

export const DEFAULT_SETTINGS: GuildSettings = {
  timezone: 'America/Los_Angeles',

  core: { prefix: null, textCommands: true },

  modules: { clips: true, activity: true, purge: true },

  channels: { clips: null, highlights: null },

  // Unicode by default so Camelot looks right the moment it joins any server.
  // A server that has matching emojis gets them adopted automatically on join
  // (see adoptServerEmojis), and any slot can be set by hand afterwards.
  emojis: { ...EMOJI_FALLBACKS },

  permissions: {
    adminRoles: [],
    adminEditable: ['channels', 'clips', 'activity'],
  },

  media: {
    allowImages: true,
    allowVideos: true,
    allowAudio: false,
    allowStickers: true,
    providers: [
      'tiktok.com',
      'instagram.com',
      'ddinstagram.com',
      'youtube.com',
      'youtu.be',
      'twitch.tv',
      'x.com',
      'twitter.com',
      'fxtwitter.com',
      'vxtwitter.com',
      'streamable.com',
      'tenor.com',
      'giphy.com',
      'gfycat.com',
      'imgur.com',
      'redd.it',
      'reddit.com',
      'medal.tv',
      'outplayed.tv',
      'discordapp.com',
      'discordapp.net',
    ],
    blockedProviders: [],
    graceMs: 4000,
    bypassRoles: [],
    bypassModerators: false,
    warning: {
      mode: 'channel',
      text: 'Media only. Add a clip, photo, GIF, or media link.',
      deleteAfterSeconds: 5,
      pingAuthor: false,
      cooldownSeconds: 20,
      dmAutoDelete: false,
    },
  },

  voting: { exclusive: true, countAuthorVote: false, downvotesSubtract: false },

  weekly: {
    dayOfWeek: 5,
    time: '20:00',
    title: 'Clip of the Week',
    minVotes: 1,
    announceNoWinner: false,
  },

  activity: {
    enabled: true,
    textMode: 'only',
    voiceMode: 'all',
    textChannels: [],
    voiceChannels: [],
    ignoredChannels: [],
    dailyMessageCap: 12,
    messageCooldownSeconds: 45,
    activeCooldownSeconds: 8,
    minMessageLength: 2,
    activeDayVoiceMinutes: 15,
    activeDayMessages: 5,
    dailyVoiceCapMinutes: 180,
    gracePeriodDays: 30,
    retentionDays: 180,
  },

  purge: {
    rolePolicies: [],
    absoluteRoles: [],
    inactivityDays: 21,
    minObservedDays: 21,
    logRetentionDays: 365,
  },
};

/* ---------------------------------------------------------------------------
 * Storage
 * ------------------------------------------------------------------------- */

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameValue(a[key], b[key]));
  }
  return false;
}

/** Deep-merge `stored` over `base`. Arrays replace. Unknown keys are dropped. */
export function mergeDefaults<T>(base: T, stored: unknown): T {
  if (!isPlainObject(stored) || !isPlainObject(base)) return base;
  const out: Plain = { ...(base as unknown as Plain) };
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in out)) continue;
    const baseValue = out[key];
    out[key] = isPlainObject(baseValue) && isPlainObject(value) ? mergeDefaults(baseValue, value) : value;
  }
  return out as unknown as T;
}

/** Keep only what differs from the defaults. */
export function diffFromDefaults(current: unknown, base: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(base)) return current;
  const out: Plain = {};
  for (const [key, value] of Object.entries(current)) {
    const baseValue = base[key];
    if (sameValue(value, baseValue)) continue;
    out[key] = isPlainObject(value) && isPlainObject(baseValue) ? diffFromDefaults(value, baseValue) : value;
  }
  return out;
}

const cache = new Map<string, GuildSettings>();

export function getSettings(guildId: string): GuildSettings {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const row = getDb().prepare(`SELECT data FROM guild_settings WHERE guild_id = ?`).get(guildId) as
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
  const merged = mergeDefaults(DEFAULT_SETTINGS, parsed);
  cache.set(guildId, merged);
  return merged;
}

export function saveSettings(guildId: string, next: GuildSettings): void {
  getDb()
    .prepare(
      `INSERT INTO guild_settings (guild_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .run(guildId, JSON.stringify(diffFromDefaults(next, DEFAULT_SETTINGS)), Date.now());
  cache.set(guildId, next);
}

export function updateSettings(guildId: string, patch: Plain): GuildSettings {
  const next = mergeDefaults(getSettings(guildId), patch);
  saveSettings(guildId, next);
  return next;
}

export function getByPath(settings: GuildSettings, path: string): unknown {
  let node: unknown = settings;
  for (const key of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

export function patchFromPath(path: string, value: unknown): Plain {
  const keys = path.split('.');
  const root: Plain = {};
  let node = root;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) node[key] = value;
    else {
      const child: Plain = {};
      node[key] = child;
      node = child;
    }
  });
  return root;
}

export function setByPath(guildId: string, path: string, value: unknown): GuildSettings {
  return updateSettings(guildId, patchFromPath(path, value));
}

export function clearSettingsCache(guildId?: string): void {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

export function highlightsChannelId(s: GuildSettings): string | null {
  return s.channels.highlights ?? s.channels.clips;
}
