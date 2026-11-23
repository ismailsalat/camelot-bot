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
import { enabledGames, type GameEntry, type GuildSettings } from '../db/settings.js';
import { parseEmoji, resolveEmoji } from '../util/emoji.js';
import { Ids } from './ids.js';
import type { MessageRow } from '../ui/types.js';

type Rows = MessageRow[];

/** Step 1: which game. One tap. */
export function renderGameStep(
  settings: GuildSettings,
  client?: Client,
): { content: string; components: Rows } {
  const games = enabledGames(settings);

  if (games.length === 0) {
    return { content: 'No games set up yet. An admin can add some in `/camelot settings`.', components: [] };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(Ids.pickGame())
    .setPlaceholder('Pick a game')
    .addOptions(
      games.slice(0, 25).map((game) => {
        const option = new StringSelectMenuOptionBuilder().setLabel(game.name).setValue(game.id);
        const emoji = parseEmoji(resolveEmoji(game.emoji, '🎮', client));
        if (emoji) option.setEmoji(emoji.reactionKey);
        return option;
      }),
    );

  // A message needs text as well as components — Discord rejects an empty one.
  return {
    content: 'Pick a game.',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON()],
  };
}

function timeLabel(minutes: number): string {
  if (minutes === 0) return 'Now';
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

/** Step 2: when. */
export function renderTimeStep(
  game: GameEntry,
  settings: GuildSettings,
  client?: Client,
  note?: string,
): { content: string; components: Rows } {
  const row = new ActionRowBuilder<ButtonBuilder>();

  settings.games.quickOffsets.slice(0, 4).forEach((minutes, index) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(Ids.pickTime(game.id, minutes))
        .setLabel(timeLabel(minutes))
        .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  });

  if (settings.games.allowCustomTime) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(Ids.pickCustom(game.id))
        .setLabel('Other time')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  const emoji = resolveEmoji(game.emoji, '🎮', client);
  const head = `${emoji} **${game.name}** — when?`;

  return {
    content: note ? `${note}\n${head}` : head,
    components: row.components.length > 0 ? [row.toJSON()] : [],
  };
}

/** The one small modal in the whole member journey. */
export function buildCustomTimeModal(game: GameEntry): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(Ids.customTimeModal(game.id))
    .setTitle(`${game.name} — what time?`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(Ids.customTimeInput)
          .setLabel('Time')
          .setPlaceholder('9:30pm · 21:30 · in 45')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20),
      ),
    );
}
