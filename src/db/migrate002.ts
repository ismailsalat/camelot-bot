import type { Database as Db } from 'better-sqlite3';

/**
 * v1 stored the whole settings object, so every default was frozen on the
 * first save and later improvements could never reach a server. v2 stores only
 * what an admin actually changed.
 *
 * This rewrites existing rows into the slim form, and in doing so drops values
 * that merely matched a v1 default — which is what the admin never chose.
 * Anything genuinely customised is kept.
 *
 * It also moves `games.options: string[]` to `games.list: GameEntry[]`.
 */

/** A frozen copy of the v1 defaults. Do not edit — history, not configuration. */
const V1_DEFAULTS: Record<string, unknown> = {
  timezone: 'America/Los_Angeles',
  features: { sessions: true, mediaOnly: true, voting: true, clipOfWeek: true, notifications: true },
  channels: { panel: null, sessions: null, clips: null, highlights: null },
  panel: {
    title: "Who's down?",
    body: 'Start a game, get friends together, and join a voice channel automatically.',
    startLabel: 'Start a Game',
    notifyLabel: 'Notifications',
    messageId: null,
  },
  games: {
    options: ['Marvel Rivals', 'GTA', 'Valorant', 'Fortnite', 'Other'],
    quickOffsets: [0, 15, 30],
    allowCustomTime: true,
    durationMinutes: 180,
    deleteOnClose: false,
  },
  voice: { eligible: [], excluded: [], allowShared: false, requireCapacity: true },
  media: {
    allowImages: true,
    allowVideos: true,
    allowAudio: false,
    allowStickers: true,
    providers: [
      'tiktok.com', 'instagram.com', 'ddinstagram.com', 'youtube.com', 'youtu.be',
      'twitch.tv', 'x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com',
      'streamable.com', 'tenor.com', 'giphy.com', 'gfycat.com', 'imgur.com',
      'redd.it', 'reddit.com', 'medal.tv', 'outplayed.tv', 'discordapp.com', 'discordapp.net',
    ],
    blockedProviders: [],
    graceMs: 4000,
    bypassRoles: [],
    bypassModerators: true,
    warning: {
      mode: 'channel',
      text: '📎 Media only — attach a video, image, GIF, or media link with your message.',
      deleteAfterSeconds: 5,
      pingAuthor: false,
      cooldownSeconds: 20,
      dmAutoDelete: false,
    },
  },
  voting: { up: '👍', down: '👎', exclusive: true, countAuthorVote: false, downvotesSubtract: false },
  weekly: { dayOfWeek: 5, time: '20:00', title: 'Clip of the Week', minVotes: 1, announceNoWinner: false },
  notifications: {
    dmText: '🎮 {user} started **{game}** — {time}',
    quietHoursEnabled: false,
    quietStart: '23:00',
    quietEnd: '09:00',
  },
};

const DEFAULT_GAME_EMOJI: Record<string, string> = {
  'marvel rivals': '🦸',
  gta: '🚗',
  valorant: '🎯',
  fortnite: '🏝️',
  other: '🎮',
};

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

function slim(current: unknown, base: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(base)) return current;
  const out: Plain = {};
  for (const [key, value] of Object.entries(current)) {
    const baseValue = base[key];
    if (sameValue(value, baseValue)) continue;
    out[key] = isPlainObject(value) && isPlainObject(baseValue) ? slim(value, baseValue) : value;
  }
  return out;
}

function idFor(name: string, taken: string[]): string {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'game';
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-x`;
}

/** `games.options: string[]` -> `games.list: GameEntry[]`, keeping the order. */
export function convertGames(stored: Plain): void {
  const games = stored.games;
  if (!isPlainObject(games)) return;
  const options = games.options;
  if (!Array.isArray(options)) return;

  const ids: string[] = [];
  games.list = options
    .filter((name): name is string => typeof name === 'string')
    .map((name) => {
      const id = idFor(name, ids);
      ids.push(id);
      return { id, name, emoji: DEFAULT_GAME_EMOJI[name.toLowerCase()] ?? '🎮', enabled: true };
    });
  delete games.options;
}

/** Old `voting.up` / `voting.down` become emoji slots. */
export function convertVotingEmojis(stored: Plain): void {
  const voting = stored.voting;
  if (!isPlainObject(voting)) return;

  const emojis = isPlainObject(stored.emojis) ? stored.emojis : {};
  if (typeof voting.up === 'string') emojis.thumbsUp = voting.up;
  if (typeof voting.down === 'string') emojis.thumbsDown = voting.down;
  if (Object.keys(emojis).length > 0) stored.emojis = emojis;

  delete voting.up;
  delete voting.down;
}

export function migrateSettingsRow(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '{}';
  }
  if (!isPlainObject(parsed)) return '{}';

  // Drop anything that only ever matched a v1 default.
  const reduced = slim(parsed, V1_DEFAULTS);
  const out = isPlainObject(reduced) ? reduced : {};

  convertGames(out);
  convertVotingEmojis(out);

  // Tidy up containers left empty by the reduction.
  for (const [key, value] of Object.entries(out)) {
    if (isPlainObject(value) && Object.keys(value).length === 0) delete out[key];
  }
  return JSON.stringify(out);
}

/** The vote emojis a guild was actually using under v1. */
export function v1VoteEmojis(raw: string): { up: string; down: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const voting = isPlainObject(parsed) && isPlainObject(parsed.voting) ? parsed.voting : {};
  return {
    up: typeof voting.up === 'string' ? voting.up : '👍',
    down: typeof voting.down === 'string' ? voting.down : '👎',
  };
}

export function runSettingsMigration(db: Db): void {
  const rows = db.prepare(`SELECT guild_id, data FROM guild_settings`).all() as {
    guild_id: string;
    data: string;
  }[];

  const update = db.prepare(`UPDATE guild_settings SET data = ? WHERE guild_id = ?`);
  const stampClips = db.prepare(
    `UPDATE clips SET up_emoji = ?, down_emoji = ? WHERE guild_id = ? AND up_emoji IS NULL`,
  );

  for (const row of rows) {
    // Existing clips carry the emojis v1 reacted with. Record them before the
    // settings change, so votes already cast keep counting.
    const { up, down } = v1VoteEmojis(row.data);
    stampClips.run(up, down, row.guild_id);
    update.run(migrateSettingsRow(row.data), row.guild_id);
  }
}
