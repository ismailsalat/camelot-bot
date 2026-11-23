import { ChannelType } from 'discord.js';
import { getByPath, type GuildSettings } from '../db/settings.js';
import { parseEmoji } from '../util/emoji.js';
import { DAY_NAMES, isValidTimezone, parseHhMm } from '../util/time.js';

/* ---------------------------------------------------------------------------
 * One table drives the whole `/camelot settings` UI. Adding a setting is a
 * matter of adding an entry here — no new screens, no new handlers.
 * ------------------------------------------------------------------------- */

export type FieldType =
  | 'boolean'
  | 'string'
  | 'paragraph'
  | 'number'
  | 'list'
  | 'emoji'
  | 'time'
  | 'timezone'
  | 'channel'
  | 'channels'
  | 'voiceChannels'
  | 'roles'
  | 'choice';

export interface Choice {
  label: string;
  value: string;
}

export interface Field {
  path: string;
  label: string;
  hint: string;
  type: FieldType;
  category: CategoryKey;
  min?: number;
  max?: number;
  choices?: Choice[];
  channelTypes?: ChannelType[];
}

export type CategoryKey =
  | 'channels'
  | 'gameList'
  | 'emojis'
  | 'games'
  | 'voice'
  | 'media'
  | 'warning'
  | 'voting'
  | 'weekly'
  | 'notify'
  | 'copy'
  | 'features';

/** Categories handled by their own screen rather than the generic field list. */
export const CUSTOM_CATEGORIES: CategoryKey[] = ['gameList', 'emojis'];

export const CATEGORIES: { key: CategoryKey; label: string; emoji: string; blurb: string }[] = [
  { key: 'channels', label: 'Channels', emoji: '#️⃣', blurb: 'Where everything happens' },
  { key: 'gameList', label: 'Games', emoji: '🎮', blurb: 'Add, rename, reorder, hide' },
  { key: 'emojis', label: 'Emojis', emoji: '✨', blurb: 'Swap in your server emojis' },
  { key: 'games', label: 'Sessions', emoji: '⏱️', blurb: 'Times, length, panel wording' },
  { key: 'voice', label: 'Voice channels', emoji: '🔊', blurb: 'Which VCs Camelot may pick' },
  { key: 'media', label: 'Clips: what counts', emoji: '📎', blurb: 'Allowed media and link sites' },
  { key: 'warning', label: 'Clips: the warning', emoji: '⚠️', blurb: 'Wording, timing, bypasses' },
  { key: 'voting', label: 'Voting', emoji: '👍', blurb: 'Scoring rules' },
  { key: 'weekly', label: 'Clip of the Week', emoji: '⭐', blurb: 'Day, time, title, threshold' },
  { key: 'notify', label: 'Notifications', emoji: '🔔', blurb: 'Alert wording and quiet hours' },
  { key: 'copy', label: 'Wording', emoji: '💬', blurb: 'The short lines members see' },
  { key: 'features', label: 'Features on/off', emoji: '🎚️', blurb: 'Enable or disable each part' },
];

const DAY_CHOICES: Choice[] = DAY_NAMES.map((name, index) => ({ label: name, value: String(index) }));

export const FIELDS: Field[] = [
  // ------------------------------------------------------------- channels --
  { path: 'channels.panel', label: 'Games panel channel', hint: 'Where the pinned panel lives', type: 'channel', category: 'channels' },
  { path: 'channels.sessions', label: 'Session posts channel', hint: 'Defaults to the panel channel', type: 'channel', category: 'channels' },
  { path: 'channels.clips', label: 'Clips channel', hint: 'The media-only channel', type: 'channel', category: 'channels' },
  { path: 'channels.highlights', label: 'Weekly highlight channel', hint: 'Defaults to the clips channel', type: 'channel', category: 'channels' },
  { path: 'timezone', label: 'Server time zone', hint: 'e.g. America/Los_Angeles', type: 'timezone', category: 'channels' },

  // ---------------------------------------------------------------- games --
  { path: 'games.quickOffsets', label: 'Quick time buttons', hint: 'Minutes from now, e.g. 0, 15, 30', type: 'list', category: 'games' },
  { path: 'games.allowCustomTime', label: 'Allow a custom time', hint: 'Shows the "Custom" button', type: 'boolean', category: 'games' },
  { path: 'games.durationMinutes', label: 'Session length (minutes)', hint: 'Auto-closes after this long', type: 'number', category: 'games', min: 15, max: 1440 },
  { path: 'games.deleteOnClose', label: 'Delete the post when it closes', hint: 'Off keeps a tidy history', type: 'boolean', category: 'games' },
  { path: 'panel.title', label: 'Panel title', hint: 'Default: Who\'s down?', type: 'string', category: 'games' },
  { path: 'panel.body', label: 'Panel text', hint: 'The line under the title', type: 'paragraph', category: 'games' },
  { path: 'panel.startLabel', label: 'Start button label', hint: 'Default: Start a Game', type: 'string', category: 'games' },
  { path: 'panel.notifyLabel', label: 'Notifications button label', hint: 'Default: Notifications', type: 'string', category: 'games' },

  // ---------------------------------------------------------------- voice --
  { path: 'voice.eligible', label: 'Eligible voice channels', hint: 'In priority order. Empty = all public VCs', type: 'voiceChannels', category: 'voice' },
  { path: 'voice.excluded', label: 'Never pick these', hint: 'Staff/private VCs (AFK is always skipped)', type: 'voiceChannels', category: 'voice' },
  { path: 'voice.allowShared', label: 'Allow sharing a busy VC', hint: 'Only if everyone still fits', type: 'boolean', category: 'voice' },
  { path: 'voice.requireCapacity', label: 'Respect user limits', hint: 'Needs room for the whole session', type: 'boolean', category: 'voice' },

  // ---------------------------------------------------------------- media --
  { path: 'media.allowImages', label: 'Allow images & GIFs', hint: '', type: 'boolean', category: 'media' },
  { path: 'media.allowVideos', label: 'Allow videos', hint: '', type: 'boolean', category: 'media' },
  { path: 'media.allowAudio', label: 'Allow audio files', hint: 'Off by default', type: 'boolean', category: 'media' },
  { path: 'media.allowStickers', label: 'Allow stickers', hint: '', type: 'boolean', category: 'media' },
  { path: 'media.providers', label: 'Media link providers', hint: 'Comma-separated hostnames', type: 'list', category: 'media' },
  { path: 'media.blockedProviders', label: 'Blocked providers', hint: 'Never counts as media', type: 'list', category: 'media' },
  { path: 'media.graceMs', label: 'Link preview grace (ms)', hint: 'Wait before judging an unknown link', type: 'number', category: 'media', min: 0, max: 30000 },

  // -------------------------------------------------------------- warning --
  { path: 'media.warning.mode', label: 'Warning style', hint: 'Channel notice, DM, or silent', type: 'choice', category: 'warning', choices: [
    { label: 'Temporary notice in the channel', value: 'channel' },
    { label: 'Private DM', value: 'dm' },
    { label: 'Silent — just delete', value: 'silent' },
  ] },
  { path: 'media.warning.text', label: 'Warning text', hint: 'Emojis welcome', type: 'paragraph', category: 'warning' },
  { path: 'media.warning.deleteAfterSeconds', label: 'Auto-delete after (seconds)', hint: '0 keeps it forever', type: 'number', category: 'warning', min: 0, max: 300 },
  { path: 'media.warning.pingAuthor', label: 'Ping the author', hint: 'Off by default (quiet)', type: 'boolean', category: 'warning' },
  { path: 'media.warning.cooldownSeconds', label: 'Per-member cooldown (seconds)', hint: 'Stops warning floods', type: 'number', category: 'warning', min: 0, max: 3600 },
  { path: 'media.warning.dmAutoDelete', label: 'Also auto-delete the DM', hint: 'Off by default so it stays readable', type: 'boolean', category: 'warning' },
  { path: 'media.bypassRoles', label: 'Roles that can post anything', hint: '', type: 'roles', category: 'warning' },
  { path: 'media.bypassModerators', label: 'Moderators bypass', hint: 'Anyone with Manage Messages', type: 'boolean', category: 'warning' },

  // --------------------------------------------------------------- voting --
  { path: 'voting.exclusive', label: 'One side per member', hint: 'Removes the earlier vote', type: 'boolean', category: 'voting' },
  { path: 'voting.countAuthorVote', label: "Count the poster's own vote", hint: 'Off by default', type: 'boolean', category: 'voting' },
  { path: 'voting.downvotesSubtract', label: 'Downvotes subtract', hint: 'Off by default — 👍 only', type: 'boolean', category: 'voting' },

  // --------------------------------------------------------------- weekly --
  { path: 'weekly.dayOfWeek', label: 'Day', hint: 'Default: Friday', type: 'choice', category: 'weekly', choices: DAY_CHOICES },
  { path: 'weekly.time', label: 'Time (24h, local)', hint: 'e.g. 20:00', type: 'time', category: 'weekly' },
  { path: 'weekly.title', label: 'Title', hint: 'Default: Clip of the Week', type: 'string', category: 'weekly' },
  { path: 'weekly.minVotes', label: 'Minimum votes', hint: 'Below this, nothing is posted', type: 'number', category: 'weekly', min: 0, max: 1000 },
  { path: 'weekly.announceNoWinner', label: 'Post when nothing qualified', hint: 'Off by default (quiet)', type: 'boolean', category: 'weekly' },

  // --------------------------------------------------------------- notify --
  { path: 'notifications.dmText', label: 'Alert text', hint: 'Use {user}, {game}, {time}', type: 'paragraph', category: 'notify' },
  { path: 'notifications.quietHoursEnabled', label: 'Quiet hours', hint: 'Skip alerts overnight', type: 'boolean', category: 'notify' },
  { path: 'notifications.quietStart', label: 'Quiet hours start', hint: 'e.g. 23:00', type: 'time', category: 'notify' },
  { path: 'notifications.quietEnd', label: 'Quiet hours end', hint: 'e.g. 09:00', type: 'time', category: 'notify' },

  // ----------------------------------------------------------------- copy --
  { path: 'copy.joined', label: 'Joined a session', hint: "Default: You're in.", type: 'string', category: 'copy' },
  { path: 'copy.left', label: 'Left a session', hint: "Default: You're out.", type: 'string', category: 'copy' },
  { path: 'copy.starting', label: 'Session starting', hint: "Default: Game's starting.", type: 'string', category: 'copy' },
  { path: 'copy.noVoice', label: 'No VC available', hint: 'Default: No free VC right now.', type: 'string', category: 'copy' },
  { path: 'copy.dmFailed', label: "Couldn't DM", hint: 'Shown when DMs are closed', type: 'string', category: 'copy' },
  { path: 'copy.saved', label: 'Saved confirmation', hint: 'Default: Done.', type: 'string', category: 'copy' },

  // ------------------------------------------------------------- features --
  { path: 'features.sessions', label: "'I'm Down' sessions", hint: 'Panel, sessions, auto VC', type: 'boolean', category: 'features' },
  { path: 'features.mediaOnly', label: 'Media-only clips channel', hint: 'Deletes text-only posts', type: 'boolean', category: 'features' },
  { path: 'features.voting', label: 'Clip reactions', hint: 'Adds 👍 👎 to media posts', type: 'boolean', category: 'features' },
  { path: 'features.clipOfWeek', label: 'Clip of the Week', hint: 'The weekly highlight', type: 'boolean', category: 'features' },
  { path: 'features.notifications', label: 'Game notifications', hint: 'Opt-in per-game alerts', type: 'boolean', category: 'features' },
];

export function fieldsFor(category: CategoryKey): Field[] {
  return FIELDS.filter((field) => field.category === category);
}

export function fieldByPath(path: string): Field | undefined {
  return FIELDS.find((field) => field.path === path);
}

/* ------------------------------- formatting -------------------------------- */

export function formatValue(field: Field, settings: GuildSettings): string {
  const value = getByPath(settings, field.path);

  switch (field.type) {
    case 'boolean':
      return value ? '✅ on' : '⬜ off';
    case 'channel':
      return value ? `<#${String(value)}>` : '— not set —';
    case 'channels':
    case 'voiceChannels':
      return Array.isArray(value) && value.length > 0
        ? value.map((id) => `<#${String(id)}>`).join(' ')
        : '— all public VCs —';
    case 'roles':
      return Array.isArray(value) && value.length > 0 ? value.map((id) => `<@&${String(id)}>`).join(' ') : '— none —';
    case 'list':
      return Array.isArray(value) && value.length > 0 ? value.join(', ') : '— empty —';
    case 'choice':
      return field.choices?.find((choice) => choice.value === String(value))?.label ?? String(value);
    default:
      return value === null || value === undefined || value === '' ? '— not set —' : `\`${String(value)}\``;
  }
}

/* --------------------------------- parsing --------------------------------- */

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export function parseFieldValue(field: Field, raw: string): ParseResult {
  const input = raw.trim();

  switch (field.type) {
    case 'number': {
      const parsed = Number(input);
      if (!Number.isFinite(parsed)) return { ok: false, error: 'That needs to be a number.' };
      if (field.min !== undefined && parsed < field.min) return { ok: false, error: `Minimum is ${field.min}.` };
      if (field.max !== undefined && parsed > field.max) return { ok: false, error: `Maximum is ${field.max}.` };
      return { ok: true, value: Math.round(parsed) };
    }
    case 'list': {
      const items = input
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (field.path === 'games.quickOffsets') {
        const numbers = items.map(Number);
        if (numbers.some((item) => !Number.isFinite(item) || item < 0 || item > 1440)) {
          return { ok: false, error: 'Use minutes between 0 and 1440, e.g. `0, 15, 30`.' };
        }
        return { ok: true, value: numbers.slice(0, 4).map((item) => Math.round(item)) };
      }
      if (field.path === 'games.options' && items.length === 0) {
        return { ok: false, error: 'You need at least one game.' };
      }
      return { ok: true, value: items.slice(0, 25) };
    }
    case 'emoji': {
      const parsed = parseEmoji(input);
      if (!parsed) return { ok: false, error: 'That does not look like an emoji. Paste the emoji itself, or `<:name:id>`.' };
      return { ok: true, value: parsed.display };
    }
    case 'time': {
      const parsed = parseHhMm(input);
      if (!parsed) return { ok: false, error: 'Use 24-hour `HH:MM`, e.g. `20:00`.' };
      return { ok: true, value: `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}` };
    }
    case 'timezone': {
      if (!isValidTimezone(input)) return { ok: false, error: 'Unknown time zone. Try `America/Los_Angeles`.' };
      return { ok: true, value: input };
    }
    case 'choice': {
      const match = field.choices?.find(
        (choice) => choice.value === input || choice.label.toLowerCase() === input.toLowerCase(),
      );
      if (!match) return { ok: false, error: 'Pick one of the listed options.' };
      return { ok: true, value: field.path === 'weekly.dayOfWeek' ? Number(match.value) : match.value };
    }
    case 'paragraph':
    case 'string': {
      if (input.length === 0) return { ok: false, error: 'That cannot be empty.' };
      if (input.length > 400) return { ok: false, error: 'Keep it under 400 characters.' };
      return { ok: true, value: input };
    }
    default:
      return { ok: false, error: 'This one is edited with the menu, not typed.' };
  }
}

/** Fields whose value is chosen with a component rather than typed. */
export function isComponentField(field: Field): boolean {
  return ['boolean', 'channel', 'channels', 'voiceChannels', 'roles', 'choice'].includes(field.type);
}
