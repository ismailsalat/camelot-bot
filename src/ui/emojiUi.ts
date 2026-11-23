import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
} from 'discord.js';
import {
  DEFAULT_SETTINGS,
  EMOJI_FALLBACKS,
  EMOJI_LABELS,
  EMOJI_SLOTS,
  type EmojiSlot,
  type GuildSettings,
} from '../db/settings.js';
import { canUseEmoji, emojiFor, parseEmoji } from '../util/emoji.js';
import { Ids } from '../interactions/ids.js';
import type { MessageRow } from './types.js';

/**
 * One line per slot: what it's for, and what members actually see right now.
 * A configured emoji the bot can't reach is called out rather than silently
 * rendering as raw markup.
 */
export function renderEmojiHome(
  settings: GuildSettings,
  client?: Client,
  note?: string,
): { content: string; components: MessageRow[] } {
  const lines = EMOJI_SLOTS.map((slot) => {
    const configured = settings.emojis[slot];
    const shown = emojiFor(settings, slot, client);
    const parsed = parseEmoji(configured);
    const unreachable = parsed?.id && client && !canUseEmoji(client, configured);
    const label = EMOJI_LABELS[slot];
    return `${shown} ${label}${unreachable ? ' · *not available, using the backup*' : ''}`;
  });

  const content = [`${emojiFor(settings, 'sword', client)} **Emojis**`, lines.join('\n'), note ?? '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 1900);

  const select = new StringSelectMenuBuilder()
    .setCustomId(Ids.emojiPick())
    .setPlaceholder('Pick one to change')
    .addOptions(
      EMOJI_SLOTS.map((slot) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(EMOJI_LABELS[slot].split(' — ')[0] ?? slot)
          .setValue(slot)
          .setDescription(EMOJI_LABELS[slot].split(' — ')[1]?.slice(0, 100) ?? '');
        const emoji = parseEmoji(emojiFor(settings, slot, client));
        if (emoji) option.setEmoji(emoji.reactionKey);
        return option;
      }),
    );

  return {
    content,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON(),
      new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(Ids.emojiReset())
            .setLabel('Reset to defaults')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(Ids.settingsBack())
            .setLabel('Back')
            .setStyle(ButtonStyle.Secondary),
        )
        .toJSON(),
    ],
  };
}

export function buildEmojiModal(slot: EmojiSlot, settings: GuildSettings): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(Ids.emojiInput)
    .setLabel('Emoji')
    .setPlaceholder(`${EMOJI_FALLBACKS[slot]} or :YourEmoji:`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(60)
    .setValue(settings.emojis[slot]);

  return new ModalBuilder()
    .setCustomId(Ids.emojiModal(slot))
    .setTitle((EMOJI_LABELS[slot].split(' — ')[0] ?? slot).slice(0, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function defaultEmojis(): Record<EmojiSlot, string> {
  return { ...DEFAULT_SETTINGS.emojis };
}

export function isEmojiSlot(value: string): value is EmojiSlot {
  return (EMOJI_SLOTS as readonly string[]).includes(value);
}
