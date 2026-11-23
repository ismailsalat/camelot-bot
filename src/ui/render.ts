import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from 'discord.js';
import type { MessageRow } from './types.js';
import type { SessionRow } from '../db/repos.js';
import type { GuildSettings } from '../db/settings.js';
import { Ids } from '../interactions/ids.js';
import { channelLink } from '../util/discord.js';
import { emojiFor, emojiKeyFor } from '../util/emoji.js';
import { discordTime } from '../util/time.js';

const MAX_NAMES = 4;

export function formatRoster(names: string[]): string {
  if (names.length === 0) return 'nobody yet';
  if (names.length <= MAX_NAMES) return names.join(', ');
  return `${names.slice(0, MAX_NAMES).join(', ')} +${names.length - MAX_NAMES} more`;
}

export interface SessionView {
  session: SessionRow;
  names: string[];
  settings: GuildSettings;
  voiceChannelName?: string | null;
  client?: Client;
  /** The game's own emoji, already resolved. */
  gameEmoji?: string | null;
}

/**
 * One compact post. Discord timestamps mean everyone sees their own clock.
 * Emojis sit at the start of short lines, where they stay readable.
 */
export function renderSessionContent(view: SessionView): string {
  const { session, names, settings } = view;
  const lines: string[] = [];

  const mark = view.gameEmoji || emojiFor(settings, 'sword', view.client);
  const when =
    session.status === 'live'
      ? `${discordTime(session.start_at, 't')} · on now`
      : `${discordTime(session.start_at, 't')} · ${discordTime(session.start_at, 'R')}`;

  lines.push(`${mark} **${session.game}** — ${when}`);
  lines.push(`**${names.length} down:** ${formatRoster(names)}`);

  if (session.status === 'cancelled') lines.push('*Called off.*');
  else if (session.status === 'closed') lines.push('*Done.*');
  else if (view.voiceChannelName) lines.push(`🔊 **${view.voiceChannelName}**`);
  else if (session.status === 'live') lines.push(`*${settings.copy.noVoice}*`);

  return lines.join('\n');
}

export function renderSessionComponents(view: SessionView): ActionRowBuilder<ButtonBuilder>[] {
  const { session, settings, client } = view;
  const closed = session.status === 'closed' || session.status === 'cancelled';
  const row = new ActionRowBuilder<ButtonBuilder>();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(Ids.sessionJoin(session.id))
      .setLabel(closed ? 'Closed' : "I'm Down")
      .setEmoji(closed ? emojiKeyFor(settings, 'x', client) : emojiKeyFor(settings, 'check', client))
      .setStyle(closed ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(closed),
  );

  if (!closed && session.vc_channel_id) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Join VC')
        .setEmoji('🔊')
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(session.guild_id, session.vc_channel_id)),
    );
  }

  if (session.status === 'live' && !session.vc_channel_id) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(Ids.sessionRetryVc(session.id))
        .setLabel('Find a VC')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (!closed) {
    // Organizer only; anyone else gets a one-line nudge.
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(Ids.sessionCancel(session.id))
        .setEmoji(emojiKeyFor(settings, 'x', client))
        .setStyle(ButtonStyle.Secondary),
    );
  }

  return [row];
}

export function renderSession(view: SessionView): { content: string; components: MessageRow[] } {
  return {
    content: renderSessionContent(view),
    components: renderSessionComponents(view).map((row) => row.toJSON()),
  };
}

/** The one notice a joined member gets when their session starts. */
export function renderStartNotice(
  session: SessionRow,
  voiceChannelName: string | null,
  settings: GuildSettings,
  client?: Client,
): string {
  const mark = emojiFor(settings, 'sword', client);
  const lines = [`${mark} **${session.game}** — ${settings.copy.starting}`];
  if (voiceChannelName) lines.push(`Join us in **${voiceChannelName}**.`);
  else lines.push(settings.copy.noVoice);
  return lines.join('\n');
}
