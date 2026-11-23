import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type TextChannel,
} from 'discord.js';
import { log } from '../logger.js';

/** Discord error codes we treat as "expected, keep going". */
export const SOFT_ERRORS = new Set<number | string>([
  10003, // Unknown channel
  // Unknown member / unknown user. Everyday, not exceptional: Camelot looks up
  // members who may have left on almost every screen — a purge revalidation,
  // an activity card, a leaderboard row, `!allies @someone`. Logging those at
  // error level buried the real failures in noise.
  10007, // Unknown member
  10013, // Unknown user
  10008, // Unknown message
  10062, // Unknown interaction (expired)
  50001, // Missing access
  50007, // Cannot send messages to this user (DMs closed)
  50013, // Missing permissions
  50083, // Thread archived
]);

export function isSoftError(error: unknown): boolean {
  return error instanceof DiscordAPIError && SOFT_ERRORS.has(error.code);
}

/** Run a Discord call, swallowing the everyday failures and logging the rest. */
export async function soft<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (isSoftError(error)) {
      log.debug(`${what}: ${(error as DiscordAPIError).message}`);
      return null;
    }
    log.error(`${what} failed`, error);
    return null;
  }
}

export async function fetchTextChannel(guild: Guild, channelId: string | null): Promise<TextChannel | null> {
  if (!channelId) return null;
  const channel = await soft(`fetch channel ${channelId}`, () => guild.channels.fetch(channelId));
  if (!channel) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return null;
  return channel as TextChannel;
}

/** Permissions the bot needs in a channel before it tries to post there. */
export function botCanPost(channel: GuildBasedChannel): boolean {
  const me = channel.guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return !!perms?.has(PermissionFlagsBits.ViewChannel) && !!perms.has(PermissionFlagsBits.SendMessages);
}

export function botCan(channel: GuildBasedChannel, ...flags: bigint[]): boolean {
  const me = channel.guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return !!perms && flags.every((flag) => perms.has(flag));
}

/** A clickable jump link for any message. */
export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Clicking this opens (and for voice, joins) the channel in the Discord client. */
export function channelLink(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}
