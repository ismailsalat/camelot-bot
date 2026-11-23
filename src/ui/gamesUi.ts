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
import type { GameEntry, GuildSettings } from '../db/settings.js';
import { parseEmoji, resolveEmoji } from '../util/emoji.js';
import { Ids } from '../interactions/ids.js';
import type { MessageRow } from './types.js';

/** The games list, with one row of actions for whichever game is selected. */
export function renderGamesHome(
  settings: GuildSettings,
  client?: Client,
  selectedId?: string,
  note?: string,
): { content: string; components: MessageRow[] } {
  const games = settings.games.list;

  const lines = games.map((game, index) => {
    const emoji = resolveEmoji(game.emoji, '🎮', client);
    const state = game.enabled ? '' : ' · *hidden*';
    return `\`${index + 1}.\` ${emoji} **${game.name}**${state}`;
  });

  const content = [
    '🎮 **Games**',
    lines.length > 0 ? lines.join('\n') : '*Nothing here yet.*',
    note ?? '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1900);

  const rows: MessageRow[] = [];

  if (games.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(Ids.gamesPick())
      .setPlaceholder('Pick one to change')
      .addOptions(
        games.slice(0, 25).map((game) => {
          const option = new StringSelectMenuOptionBuilder()
            .setLabel(game.name)
            .setValue(game.id)
            .setDefault(game.id === selectedId);
          const emoji = parseEmoji(resolveEmoji(game.emoji, '🎮', client));
          if (emoji) option.setEmoji(emoji.reactionKey);
          if (!game.enabled) option.setDescription('Hidden from the picker');
          return option;
        }),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON());
  }

  const selected = selectedId ? games.find((game) => game.id === selectedId) : undefined;
  if (selected) {
    const index = games.findIndex((game) => game.id === selected.id);
    rows.push(
      new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(Ids.gamesEditModal(selected.id))
            .setLabel('Rename / emoji')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(Ids.gamesToggle(selected.id))
            .setLabel(selected.enabled ? 'Hide' : 'Show')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(Ids.gamesUp(selected.id))
            .setLabel('↑')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(index <= 0),
          new ButtonBuilder()
            .setCustomId(Ids.gamesDown(selected.id))
            .setLabel('↓')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(index === games.length - 1),
          new ButtonBuilder()
            .setCustomId(Ids.gamesDelete(selected.id))
            .setLabel('Remove')
            .setStyle(ButtonStyle.Danger),
        )
        .toJSON(),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(Ids.gamesAdd())
          .setLabel('Add a game')
          .setStyle(ButtonStyle.Success)
          .setDisabled(games.length >= 25),
        new ButtonBuilder()
          .setCustomId(Ids.settingsBack())
          .setLabel('Back')
          .setStyle(ButtonStyle.Secondary),
      )
      .toJSON(),
  );

  return { content, components: rows };
}

function gameModal(customId: string, title: string, game?: GameEntry): ModalBuilder {
  const name = new TextInputBuilder()
    .setCustomId(Ids.gameNameInput)
    .setLabel('Name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(60);

  const emoji = new TextInputBuilder()
    .setCustomId(Ids.gameEmojiInput)
    .setLabel('Emoji')
    .setPlaceholder('🎮 or :YourEmoji:')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(60);

  if (game) {
    name.setValue(game.name);
    emoji.setValue(game.emoji);
  }

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(name),
      new ActionRowBuilder<TextInputBuilder>().addComponents(emoji),
    );
}

export function buildAddGameModal(): ModalBuilder {
  return gameModal(Ids.gamesAddModal(), 'Add a game');
}

export function buildEditGameModal(game: GameEntry): ModalBuilder {
  return gameModal(Ids.gamesEditModal(game.id), `Edit ${game.name}`, game);
}
