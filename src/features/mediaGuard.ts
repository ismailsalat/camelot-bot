import { PermissionFlagsBits, type Message, type GuildMember } from 'discord.js';
import { clips, cooldowns } from '../db/repos.js';
import { getSettings, type GuildSettings } from '../db/settings.js';
import { emojiFor } from '../util/emoji.js';
import { inspect, type InspectInput, type MediaRules, type Verdict } from './mediaDetect.js';
import { addVoteReactions } from './voting.js';
import { botCan, soft } from '../util/discord.js';
import { NO_MENTIONS, onlyUser } from '../util/mentions.js';
import { isModuleEnabled } from '../core/registry.js';
import { looksLikeTextCommand } from '../core/textCommands.js';
import { log } from '../logger.js';

export function rulesFrom(settings: GuildSettings): MediaRules {
  return {
    allowImages: settings.media.allowImages,
    allowVideos: settings.media.allowVideos,
    allowAudio: settings.media.allowAudio,
    allowStickers: settings.media.allowStickers,
    providers: settings.media.providers,
    blockedProviders: settings.media.blockedProviders,
  };
}

/** Flatten a live discord.js Message into the shape the rules understand. */
export function toInspectInput(message: Message): InspectInput {
  return {
    content: message.content ?? '',
    attachments: [...message.attachments.values()].map((attachment) => ({
      contentType: attachment.contentType,
      name: attachment.name,
      url: attachment.url,
    })),
    embeds: message.embeds.map((embed) => ({
      type: (embed.data as { type?: string }).type ?? null,
      url: embed.url,
      hasImage: !!embed.image,
      hasVideo: !!embed.video,
      hasThumbnail: !!embed.thumbnail,
    })),
    stickerCount: message.stickers.size,
  };
}

function isExempt(message: Message, settings: GuildSettings): boolean {
  if (message.author.bot) return true;
  if (message.system) return true;
  // A text command is an instruction to Camelot, not a failed clip post. The
  // command handler cleans it up itself; deleting it here as "not media"
  // would make `!allies` in the clips channel look broken.
  if (message.inGuild() && looksLikeTextCommand(message)) return true;
  const member = message.member as GuildMember | null;
  if (!member) return false;
  if (settings.media.bypassRoles.some((roleId) => member.roles.cache.has(roleId))) return true;
  if (settings.media.bypassModerators && member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  return false;
}

/** Entry point from the messageCreate event. */
export async function handleClipsMessage(message: Message): Promise<void> {
  if (!message.inGuild()) return;
  const settings = getSettings(message.guildId);
  if (!isModuleEnabled(settings, 'clips')) return;
  if (message.channelId !== settings.channels.clips) return;
  if (isExempt(message, settings)) return;

  const verdict = inspect(toInspectInput(message), rulesFrom(settings));

  if (verdict.kind === 'media') {
    await acceptClip(message, settings);
    return;
  }

  if (verdict.kind === 'ambiguous') {
    // Discord sometimes attaches a link preview a beat after the message lands.
    // Wait it out, re-read the message, and only then judge it.
    await wait(settings.media.graceMs);
    const fresh = await soft('re-fetch message', () => message.fetch());
    if (!fresh) return; // already gone
    // The edit handler may have accepted it while we waited.
    if (clips.byId(fresh.id)) return;

    const second = inspect(toInspectInput(fresh), rulesFrom(settings));
    if (second.kind === 'media') {
      await acceptClip(fresh, settings);
      return;
    }
    await rejectMessage(fresh, settings, second.reason);
    return;
  }

  await rejectMessage(message, settings, verdict.reason);
}

/**
 * A message edit can turn text into media (and Discord fires an update when a
 * preview resolves), so re-check anything we previously let through unjudged.
 */
export async function handleClipsUpdate(message: Message): Promise<void> {
  if (!message.inGuild()) return;
  const settings = getSettings(message.guildId);
  if (message.channelId !== settings.channels.clips) return;
  if (isExempt(message, settings)) return;
  if (clips.byId(message.id)) return; // already accepted and reacted

  const verdict = inspect(toInspectInput(message), rulesFrom(settings));
  if (verdict.kind === 'media') await acceptClip(message, settings);
}

async function acceptClip(message: Message, settings: GuildSettings): Promise<void> {
  if (!message.inGuild()) return;
  const isNew = clips.record({
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author.id,
    createdAt: message.createdTimestamp,
  });
  if (!isNew) return; // never react twice to the same post
  await addVoteReactions(message, settings);
}

export async function rejectMessage(
  message: Message,
  settings: GuildSettings,
  reason: string,
): Promise<void> {
  if (!message.inGuild()) return;
  if (!isModuleEnabled(settings, 'clips')) return;

  const channel = message.channel;
  if (!botCan(channel, PermissionFlagsBits.ManageMessages)) {
    log.warn(`Cannot delete in #${'name' in channel ? channel.name : message.channelId} — I need Manage Messages.`);
    return;
  }

  const deleted = await soft('delete non-media message', () => message.delete());
  if (!deleted) return;
  log.debug(`Removed a non-media message in ${message.guildId} (${reason}).`);

  const warning = settings.media.warning;
  if (warning.mode === 'silent') return;

  // Rate limit so a burst of text can't turn into a wall of warnings.
  if (!cooldowns.take(message.guildId, message.author.id, warning.cooldownSeconds * 1000)) return;

  if (warning.mode === 'dm') {
    const sent = await soft('warn via DM', () =>
      message.author.send({
        content: `${emojiFor(settings, 'shield', message.client)} ${warning.text}`,
        allowedMentions: NO_MENTIONS,
      }),
    );
    // A bot can delete its own DM, but we leave it by default so the member can read it.
    if (sent && warning.dmAutoDelete && warning.deleteAfterSeconds > 0) {
      setTimeout(() => {
        void soft('delete DM warning', () => sent.delete());
      }, warning.deleteAfterSeconds * 1000).unref?.();
    }
    return;
  }

  if (!channel.isSendable()) return;

  // Shield first, then short text — keeps a detailed emoji readable.
  const shield = emojiFor(settings, 'shield', message.client);
  const body = `${shield} ${warning.text}`;
  const content = warning.pingAuthor ? `${message.author.toString()} ${body}` : body;
  const notice = await soft('post media warning', () =>
    channel.send({
      content,
      // Exactly one user at most — never a role, never @everyone.
      allowedMentions: warning.pingAuthor ? onlyUser(message.author.id) : NO_MENTIONS,
    }),
  );
  if (!notice) return;

  if (warning.deleteAfterSeconds > 0) {
    const timer = setTimeout(() => {
      void soft('auto-delete media warning', () => notice.delete());
    }, warning.deleteAfterSeconds * 1000);
    timer.unref?.();
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}
