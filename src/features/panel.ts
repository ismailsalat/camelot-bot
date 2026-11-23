import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type Guild,
  type Message,
} from 'discord.js';
import { getSettings, setByPath } from '../db/settings.js';
import { emojiFor, emojiKeyFor } from '../util/emoji.js';
import { Ids } from '../interactions/ids.js';
import { botCan, fetchTextChannel, soft } from '../util/discord.js';
import { NO_MENTIONS } from '../util/mentions.js';
import { log } from '../logger.js';

function panelBody(guild: Guild): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const settings = getSettings(guild.id);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(Ids.panelStart())
      .setLabel(settings.panel.startLabel)
      .setEmoji(emojiKeyFor(settings, 'sword', guild.client))
      .setStyle(ButtonStyle.Primary),
  );
  if (settings.features.notifications) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(Ids.panelNotify())
        .setLabel(settings.panel.notifyLabel)
        .setEmoji('🔔')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  // The crown sits alone at the start of a short line, where it stays legible.
  return {
    content: `${emojiFor(settings, 'crown', guild.client)} **${settings.panel.title}**\n${settings.panel.body}`,
    components: [row],
  };
}

/** Post the panel (or edit the existing one), then pin it. */
export async function postPanel(guild: Guild, force = false): Promise<Message | null> {
  const settings = getSettings(guild.id);
  if (!settings.features.sessions) return null;

  const channel = await fetchTextChannel(guild, settings.channels.panel);
  if (!channel) return null;
  if (!botCan(channel, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages)) {
    log.warn(`Cannot post the panel in #${channel.name} — I need View Channel and Send Messages.`);
    return null;
  }

  const body = panelBody(guild);

  if (settings.panel.messageId && !force) {
    const existing = await soft('fetch panel', () => channel.messages.fetch(settings.panel.messageId!));
    if (existing) {
      await soft('edit panel', () => existing.edit({ ...body, allowedMentions: NO_MENTIONS }));
      await ensurePinned(existing);
      return existing;
    }
  }

  // Clean up the previous panel so we never leave two behind.
  if (settings.panel.messageId) {
    const stale = await soft('fetch stale panel', () => channel.messages.fetch(settings.panel.messageId!));
    if (stale) await soft('delete stale panel', () => stale.delete());
  }

  const posted = await soft('post panel', () =>
    channel.send({ ...body, allowedMentions: NO_MENTIONS }),
  );
  if (!posted) return null;

  setByPath(guild.id, 'panel.messageId', posted.id);
  await ensurePinned(posted);
  log.info(`Panel posted in #${channel.name} (${guild.name})`);
  return posted;
}

async function ensurePinned(message: Message): Promise<void> {
  if (message.pinned || !message.inGuild()) return;
  if (!botCan(message.channel, PermissionFlagsBits.ManageMessages)) {
    log.debug('Skipping pin — I need Manage Messages in that channel.');
    return;
  }
  await soft('pin panel', () => message.pin());
}

/** On boot: make sure each guild's panel still exists, without spamming. */
export async function ensurePanels(guilds: Iterable<Guild>): Promise<void> {
  for (const guild of guilds) {
    const settings = getSettings(guild.id);
    if (!settings.features.sessions || !settings.channels.panel) continue;
    await postPanel(guild, false);
  }
}
