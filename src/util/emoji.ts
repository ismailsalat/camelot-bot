import type { Client, Guild, MessageReaction } from 'discord.js';
import { EMOJI_FALLBACKS, type EmojiSlot, type GuildSettings } from '../db/settings.js';

export interface ParsedEmoji {
  /** Custom emoji snowflake, or null for a plain unicode emoji. */
  id: string | null;
  /** Emoji name (custom) or the unicode character itself. */
  name: string;
  animated: boolean;
  /** What to store in settings and show in message text. */
  display: string;
  /** What `message.react()` wants: the bare `name:id`. */
  reactionKey: string;
}

const CUSTOM = /^<?(a)?:?([\w~-]{2,32}):(\d{15,25})>?$/;

/** Accepts "👍", "<:pog:123…>", "<a:spin:123…>" or "pog:123…". */
export function parseEmoji(input: string): ParsedEmoji | null {
  const value = input.trim();
  if (!value) return null;

  const custom = CUSTOM.exec(value);
  if (custom) {
    const animated = custom[1] === 'a';
    const name = custom[2]!;
    const id = custom[3]!;
    return {
      id,
      name,
      animated,
      display: `<${animated ? 'a' : ''}:${name}:${id}>`,
      reactionKey: `${name}:${id}`,
    };
  }

  if (value.length <= 16 && !value.includes(':') && !/\s/.test(value)) {
    return { id: null, name: value, animated: false, display: value, reactionKey: value };
  }
  return null;
}

/** True if the bot shares a server with this emoji (unicode is always fine). */
export function canUseEmoji(client: Client, configured: string): boolean {
  const parsed = parseEmoji(configured);
  if (!parsed) return false;
  if (!parsed.id) return true;
  const emoji = client.emojis.cache.get(parsed.id);
  return !!emoji && emoji.available !== false;
}

/**
 * The emoji for a slot, as text to put in a message.
 * Falls back to unicode whenever the configured one isn't usable, so a server
 * without the custom pack still reads correctly instead of showing raw markup.
 */
export function emojiFor(settings: GuildSettings, slot: EmojiSlot, client?: Client): string {
  const configured = settings.emojis[slot];
  const parsed = parseEmoji(configured);
  if (!parsed) return EMOJI_FALLBACKS[slot];
  if (!parsed.id) return parsed.display;
  if (client && !canUseEmoji(client, configured)) return EMOJI_FALLBACKS[slot];
  return parsed.display;
}

/** The same choice, in the form `message.react()` wants. */
export function emojiKeyFor(settings: GuildSettings, slot: EmojiSlot, client?: Client): string {
  const resolved = emojiFor(settings, slot, client);
  return parseEmoji(resolved)?.reactionKey ?? EMOJI_FALLBACKS[slot];
}

/**
 * What buttons and select menus need.
 *
 * Deliberately an object rather than `name:id`: given the bare form, the
 * builders set `animated: false`, and an animated emoji then renders as a
 * frozen first frame. Passing the flag explicitly keeps it moving.
 */
export function componentEmoji(
  configured: string,
  fallback: string,
): string | { id: string; name: string; animated: boolean } {
  const parsed = parseEmoji(configured) ?? parseEmoji(fallback);
  if (!parsed) return fallback;
  if (!parsed.id) return parsed.display; // unicode
  return { id: parsed.id, name: parsed.name, animated: parsed.animated };
}

/** Slot version of the above. */
export function componentEmojiFor(
  settings: GuildSettings,
  slot: EmojiSlot,
  client?: Client,
): string | { id: string; name: string; animated: boolean } {
  return componentEmoji(emojiFor(settings, slot, client), EMOJI_FALLBACKS[slot]);
}

/** Resolve an arbitrary configured emoji (a game's, say) with a fallback. */
export function resolveEmoji(configured: string, fallback: string, client?: Client): string {
  const parsed = parseEmoji(configured);
  if (!parsed) return fallback;
  if (parsed.id && client && !canUseEmoji(client, configured)) return fallback;
  return parsed.display;
}

/** True when a reaction matches the configured emoji. */
export function reactionMatches(reaction: MessageReaction, configured: string): boolean {
  const parsed = parseEmoji(configured);
  if (!parsed) return false;
  return parsed.id ? reaction.emoji.id === parsed.id : reaction.emoji.name === parsed.name;
}

/** Kept for callers that have a guild rather than a client. */
export function canUseEmojiInGuild(guild: Guild, configured: string): boolean {
  return canUseEmoji(guild.client, configured);
}
