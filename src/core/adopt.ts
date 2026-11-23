import type { Guild } from 'discord.js';
import {
  DEFAULT_SETTINGS,
  EMOJI_ADOPT_NAMES,
  EMOJI_SLOTS,
  getSettings,
  setByPath,
  type EmojiSlot,
} from '../db/settings.js';
import { log } from '../logger.js';

/**
 * Camelot ships with unicode emojis so it looks right in any server from the
 * first second. If the server happens to have its own matching set, it adopts
 * them once — nobody should have to paste ten emoji IDs by hand.
 *
 * Only slots still on their default are touched, so a deliberate choice is
 * never overwritten.
 */
export function adoptServerEmojis(guild: Guild): number {
  const settings = getSettings(guild.id);
  let adopted = 0;

  for (const slot of EMOJI_SLOTS) {
    if (settings.emojis[slot] !== DEFAULT_SETTINGS.emojis[slot]) continue;

    const wanted = EMOJI_ADOPT_NAMES[slot as EmojiSlot];
    const match = guild.emojis.cache.find(
      (emoji) => !!emoji.name && wanted.includes(emoji.name.toLowerCase()),
    );
    if (!match) continue;

    setByPath(guild.id, `emojis.${slot}`, `<${match.animated ? 'a' : ''}:${match.name}:${match.id}>`);
    adopted += 1;
  }

  if (adopted > 0) log.info(`Adopted ${adopted} server emoji(s) in ${guild.name}.`);
  return adopted;
}

/**
 * A sensible first guess at the clips channel, so a new server is useful
 * before anyone opens Settings. Only ever fills a blank — never overrides.
 */
export function suggestChannels(guild: Guild): void {
  const settings = getSettings(guild.id);
  if (settings.channels.clips) return;

  const candidate = guild.channels.cache.find(
    (channel) => channel.isTextBased() && /^(clips|media|highlights)$/i.test(channel.name ?? ''),
  );
  if (candidate) {
    setByPath(guild.id, 'channels.clips', candidate.id);
    log.info(`Guessed #${candidate.name} as the clips channel in ${guild.name}.`);
  }
}

/**
 * Lobby channels that exist only to hand you straight to a new one. Nobody
 * stays in them, so counting time there is meaningless — and if two people
 * happen to land at once it would be noise.
 */
const LOBBY_PATTERN = /(join to create|join-to-create|create (a )?(vc|channel)|\+ ?new vc)/i;

export function excludeLobbyChannels(guild: Guild): number {
  const settings = getSettings(guild.id);
  const already = new Set(settings.activity.ignoredChannels);

  const lobbies = guild.channels.cache
    .filter((channel) => channel.isVoiceBased() && LOBBY_PATTERN.test(channel.name ?? ''))
    .map((channel) => channel.id)
    .filter((id) => !already.has(id));

  if (lobbies.length === 0) return 0;
  setByPath(guild.id, 'activity.ignoredChannels', [...already, ...lobbies]);
  log.info(`Excluded ${lobbies.length} join-to-create lobby channel(s) in ${guild.name}.`);
  return lobbies.length;
}

export function onJoinGuild(guild: Guild): void {
  adoptServerEmojis(guild);
  suggestChannels(guild);
  excludeLobbyChannels(guild);
}
