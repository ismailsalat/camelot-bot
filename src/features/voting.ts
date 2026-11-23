import {
  PermissionFlagsBits,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { clips } from '../db/repos.js';
import { getSettings, type GuildSettings } from '../db/settings.js';
import { canUseEmoji, emojiFor, parseEmoji, reactionMatches } from '../util/emoji.js';
import { botCan, soft } from '../util/discord.js';
import { isModuleEnabled } from '../core/registry.js';
import { log } from '../logger.js';

const warned = new Set<string>();

function warnOnce(guildId: string, detail: string): void {
  const key = `${guildId}:${detail}`;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(`Voting in ${guildId}: ${detail}.`);
}

/** The vote emojis a guild is currently set up to use. */
export function voteEmojis(settings: GuildSettings, client?: Client): { up: string; down: string } {
  return {
    up: emojiFor(settings, 'thumbsUp', client),
    down: emojiFor(settings, 'thumbsDown', client),
  };
}

/** Two reactions, on the member's own post. No ballot, no second message. */
export async function addVoteReactions(message: Message, settings: GuildSettings): Promise<void> {
  if (!message.inGuild()) return;
  if (!botCan(message.channel, PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory)) {
    warnOnce(message.guildId, 'I need Add Reactions and Read Message History in the clips channel');
    return;
  }

  const { up, down } = voteEmojis(settings, message.client);

  for (const configured of [up, down]) {
    const parsed = parseEmoji(configured);
    if (!parsed) {
      warnOnce(message.guildId, `"${configured}" is not a usable emoji`);
      continue;
    }
    if (parsed.id && !canUseEmoji(message.client, configured)) {
      warnOnce(message.guildId, `I can't use ${configured} — I need to be in the server that owns it`);
      continue;
    }
    await soft('add vote reaction', () => message.react(parsed.reactionKey));
  }

  // Remember what we actually used, so changing the emojis later doesn't
  // silently throw away votes already cast on older clips.
  clips.markReacted(message.id, up, down);
}

/** Optional "one side per member": 👍 after 👎 drops the earlier one. */
export async function enforceExclusiveVote(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;
  const message = reaction.message;
  if (!message.guildId) return;

  const settings = getSettings(message.guildId);
  if (!isModuleEnabled(settings, 'clips') || !settings.voting.exclusive) return;
  if (message.channelId !== settings.channels.clips) return;

  const clip = clips.byId(message.id);
  if (!clip) return;

  // Judge against the emojis this clip was reacted with.
  const up = clip.up_emoji ?? emojiFor(settings, 'thumbsUp');
  const down = clip.down_emoji ?? emojiFor(settings, 'thumbsDown');

  const isUp = reactionMatches(reaction as MessageReaction, up);
  const isDown = reactionMatches(reaction as MessageReaction, down);
  if (!isUp && !isDown) return;

  const opposite = isUp ? down : up;
  const full = await soft('fetch message for vote', () => message.fetch());
  if (!full) return;

  if (!full.inGuild() || !botCan(full.channel, PermissionFlagsBits.ManageMessages)) {
    warnOnce(message.guildId, 'I need Manage Messages to keep votes to one side per person');
    return;
  }

  const parsedOpposite = parseEmoji(opposite);
  if (!parsedOpposite) return;

  const existing = full.reactions.cache.find((candidate) =>
    parsedOpposite.id ? candidate.emoji.id === parsedOpposite.id : candidate.emoji.name === parsedOpposite.name,
  );
  if (!existing) return;

  const voters = await soft('fetch reaction users', () => existing.users.fetch());
  if (!voters?.has(user.id)) return;

  await soft('remove opposite vote', () => existing.users.remove(user.id));
}

export interface Tally {
  up: number;
  down: number;
  score: number;
}

/**
 * Count real people. Bots never count; the poster's own vote only counts if an
 * admin turned that on. Read live from Discord so the number is the truth.
 */
export async function tallyMessage(message: Message, settings: GuildSettings): Promise<Tally> {
  const clip = clips.byId(message.id);
  const up = clip?.up_emoji ?? emojiFor(settings, 'thumbsUp');
  const down = clip?.down_emoji ?? emojiFor(settings, 'thumbsDown');

  const count = async (configured: string): Promise<number> => {
    const parsed = parseEmoji(configured);
    if (!parsed) return 0;
    const reaction = message.reactions.cache.find((candidate) =>
      parsed.id ? candidate.emoji.id === parsed.id : candidate.emoji.name === parsed.name,
    );
    if (!reaction) return 0;

    const users = await soft('fetch voters', () => reaction.users.fetch({ limit: 100 }));
    if (!users) return 0;

    return users.filter((voter) => {
      if (voter.bot) return false;
      if (!settings.voting.countAuthorVote && voter.id === message.author.id) return false;
      return true;
    }).size;
  };

  const upCount = await count(up);
  const downCount = await count(down);
  return {
    up: upCount,
    down: downCount,
    score: settings.voting.downvotesSubtract ? upCount - downCount : upCount,
  };
}
