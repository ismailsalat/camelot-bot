import type { MessageMentionOptions } from 'discord.js';

/** Nothing gets pinged. The default for everything Camelot sends. */
export const NO_MENTIONS: MessageMentionOptions = { parse: [], roles: [], users: [] };

/** Pings exactly one user and nobody else — never @everyone, never a role. */
export function onlyUser(userId: string): MessageMentionOptions {
  return { parse: [], roles: [], users: [userId] };
}
