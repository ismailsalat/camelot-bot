import type { Guild, GuildMember } from 'discord.js';
import { getSettings } from '../db/settings.js';
import { DEFAULT_PREFIX, isValidPrefix } from '../env.js';
import { resolveCommand } from './registry.js';
import { soft } from '../util/discord.js';

/**
 * Text commands — `!allies`, `!purge @someone`. The same handlers as the slash
 * commands; only the way of asking differs.
 *
 * The host sets a default with COMMAND_PREFIX, and each server's owner can
 * override it, so one bot can serve a server that wants `!` and another that
 * wants `?` without a redeploy.
 */

let hostPrefix = DEFAULT_PREFIX;

/** Called once at boot with the value from the environment. */
export function setHostPrefix(prefix: string): void {
  hostPrefix = isValidPrefix(prefix) ? prefix : DEFAULT_PREFIX;
}

export function hostPrefixValue(): string {
  return hostPrefix;
}

/** The prefix in force for a server: its own if set, otherwise the host's. */
export function prefixFor(guildId: string): string {
  const own = getSettings(guildId).core.prefix;
  return own && isValidPrefix(own) ? own : hostPrefix;
}

export function textCommandsEnabled(guildId: string): boolean {
  return getSettings(guildId).core.textCommands;
}

export interface ParsedCommand {
  /** The canonical command name, with any alias already resolved. */
  name: string;
  /** Exactly what the person typed, for error messages. */
  typed: string;
  args: string[];
}

/**
 * Pulls a command out of a message. Returns null for anything that is not one,
 * which is almost every message, so this stays cheap: a prefix check first and
 * no work at all when it fails.
 */
export function parseCommand(content: string, prefix: string): ParsedCommand | null {
  if (!content.startsWith(prefix)) return null;

  const body = content.slice(prefix.length).trim();
  if (body === '') return null;

  const parts = body.split(/\s+/);
  const typed = (parts[0] ?? '').toLowerCase();
  if (typed === '') return null;

  // Anything that isn't a word is almost certainly punctuation, not a command:
  // "!!!" and "!?" should never be read as one.
  if (!/^[a-z][a-z0-9-]*$/.test(typed)) return null;

  const name = resolveCommand(typed);
  if (!name) return null;

  return { name, typed, args: parts.slice(1) };
}

const MENTION = /^<@!?(\d{15,25})>$/;
const SNOWFLAKE = /^\d{15,25}$/;

/**
 * Who the command was aimed at, if anyone.
 *
 * The mention is read out of the argument text rather than the message's
 * mention list, because replying to someone puts them in that list and
 * `!purge` sent as a reply must not quietly mean "purge whoever I replied to".
 */
export async function resolveTarget(guild: Guild, args: string[]): Promise<GuildMember | null | 'not-found'> {
  const raw = args[0]?.trim();
  if (!raw) return null;

  const mention = MENTION.exec(raw);
  const id = mention?.[1] ?? (SNOWFLAKE.test(raw) ? raw : null);

  if (id) {
    const cached = guild.members.cache.get(id);
    if (cached) return cached;
    const fetched = await soft('fetch member by id', () => guild.members.fetch(id));
    return fetched ?? 'not-found';
  }

  // A name, then. Exact display name or username wins; otherwise a single
  // unambiguous prefix match. Two matches is a question, not a guess.
  const needle = args.join(' ').toLowerCase();
  const members = [...guild.members.cache.values()].filter((member) => !member.user.bot);

  const exact = members.filter(
    (member) => member.displayName.toLowerCase() === needle || member.user.username.toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0]!;

  const partial = members.filter(
    (member) =>
      member.displayName.toLowerCase().startsWith(needle) ||
      member.user.username.toLowerCase().startsWith(needle),
  );
  if (partial.length === 1) return partial[0]!;

  return 'not-found';
}
