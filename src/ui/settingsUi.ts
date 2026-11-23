import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  CATEGORIES,
  CUSTOM_CATEGORIES,
  fieldsFor,
  formatValue,
  type CategoryKey,
  type Field,
} from '../commands/fields.js';
import { getByPath, type GuildSettings } from '../db/settings.js';
import { Ids } from '../interactions/ids.js';
import type { MessageRow } from './types.js';

type Rows = MessageRow[];

/** Top level: pick a group. Keeps `/camelot settings` from being one huge form. */
export function renderSettingsHome(settings: GuildSettings): { content: string; components: Rows } {
  const select = new StringSelectMenuBuilder()
    .setCustomId(Ids.settingsCategory())
    .setPlaceholder('Pick something to change')
    .addOptions(
      CATEGORIES.map((category) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(category.label)
          .setValue(category.key)
          .setDescription(category.blurb)
          .setEmoji(category.emoji),
      ),
    );

  const missing: string[] = [];
  if (!settings.channels.panel) missing.push('games panel');
  if (!settings.channels.clips) missing.push('clips');

  const header = missing.length
    ? `Still need a channel for **${missing.join('** and **')}** — try \`/camelot setup\`.`
    : '**Camelot settings** — saved as you go.';

  return {
    content: header,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON()],
  };
}

export function renderCategory(
  category: CategoryKey,
  settings: GuildSettings,
  note?: string,
): { content: string; components: Rows } {
  const meta = CATEGORIES.find((entry) => entry.key === category)!;
  const fields = fieldsFor(category);

  const lines = fields.map((field) => `**${field.label}** — ${formatValue(field, settings)}`);
  const extra = category === 'voting' ? ['', '*Vote emojis live under Emojis.*'] : [];
  const content = [`${meta.emoji} **${meta.label}**`, ...lines, ...extra, note ? `\n${note}` : '']
    .join('\n')
    .trim();

  const select = new StringSelectMenuBuilder()
    .setCustomId(Ids.settingsField(category))
    .setPlaceholder('Pick one to change')
    .addOptions(
      fields.slice(0, 25).map((field) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(field.label.slice(0, 100))
          .setValue(field.path)
          .setDescription((field.hint || formatValue(field, settings)).slice(0, 100)),
      ),
    );

  const back = new ButtonBuilder()
    .setCustomId(Ids.settingsBack())
    .setLabel('Back')
    .setEmoji('◀️')
    .setStyle(ButtonStyle.Secondary);

  return {
    content: (content || `${meta.emoji} **${meta.label}**`).slice(0, 1900),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON(),
      new ActionRowBuilder<ButtonBuilder>().addComponents(back).toJSON(),
    ],
  };
}

/** The editor for one field: a component for pickable types, a modal for typed ones. */
export function renderFieldEditor(field: Field, settings: GuildSettings): { content: string; components: Rows } {
  const current = formatValue(field, settings);
  const header = `**${field.label}** — now: ${current}${field.hint ? `\n_${field.hint}_` : ''}`;
  const back = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(Ids.settingsBack())
        .setLabel('Back')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary),
    )
    .toJSON();

  if (field.type === 'channel') {
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(Ids.settingsChannel(field.path))
      .setPlaceholder('Pick a channel')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(0)
      .setMaxValues(1);
    const value = getByPath(settings, field.path);
    if (typeof value === 'string') select.setDefaultChannels(value);
    return {
      content: header,
      components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select).toJSON(), back],
    };
  }

  if (field.type === 'voiceChannels' || field.type === 'channels') {
    const isVoice = field.type === 'voiceChannels';
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(Ids.settingsChannel(field.path))
      .setPlaceholder(isVoice ? 'Pick voice channels (order = priority)' : 'Pick channels')
      .setChannelTypes(isVoice ? ChannelType.GuildVoice : ChannelType.GuildText)
      .setMinValues(0)
      .setMaxValues(25);
    const value = getByPath(settings, field.path);
    if (Array.isArray(value) && value.length > 0) select.setDefaultChannels(...(value as string[]));
    return {
      content: header,
      components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select).toJSON(), back],
    };
  }

  if (field.type === 'roles') {
    const select = new RoleSelectMenuBuilder()
      .setCustomId(Ids.settingsRoles(field.path))
      .setPlaceholder('Pick roles')
      .setMinValues(0)
      .setMaxValues(10);
    const value = getByPath(settings, field.path);
    if (Array.isArray(value) && value.length > 0) select.setDefaultRoles(...(value as string[]));
    return {
      content: header,
      components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select).toJSON(), back],
    };
  }

  if (field.type === 'choice') {
    const currentValue = String(getByPath(settings, field.path));
    const select = new StringSelectMenuBuilder()
      .setCustomId(Ids.settingsChoice(field.path))
      .setPlaceholder('Pick one')
      .addOptions(
        (field.choices ?? []).slice(0, 25).map((choice) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(choice.label)
            .setValue(choice.value)
            .setDefault(choice.value === currentValue),
        ),
      );
    return {
      content: header,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON(), back],
    };
  }

  // Shouldn't be reached — booleans toggle in place and the rest open a modal.
  return { content: header, components: [back] };
}

export function buildFieldModal(field: Field, settings: GuildSettings): ModalBuilder {
  const raw = getByPath(settings, field.path);
  const current = Array.isArray(raw) ? raw.join(', ') : raw === null || raw === undefined ? '' : String(raw);

  const input = new TextInputBuilder()
    .setCustomId(Ids.settingsInput)
    .setLabel(field.label.slice(0, 45))
    .setStyle(field.type === 'paragraph' || field.type === 'list' ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(field.type === 'paragraph' || field.type === 'list' ? 1000 : 100);

  if (field.hint) input.setPlaceholder(field.hint.slice(0, 100));
  if (current) input.setValue(current.slice(0, 1000));

  return new ModalBuilder()
    .setCustomId(Ids.settingsModal(field.path))
    .setTitle(field.label.slice(0, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

/** `/camelot setup` — just the channels and the VCs. */
export const SETUP_HEADER = '**Camelot setup**';

export function renderSetup(settings: GuildSettings): { content: string; components: Rows } {
  const picker = (
    path: string,
    placeholder: string,
    types: ChannelType[],
    max: number,
  ): MessageRow => {
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(Ids.settingsChannel(path))
      .setPlaceholder(placeholder)
      .setChannelTypes(...types)
      .setMinValues(0)
      .setMaxValues(max);
    const value = getByPath(settings, path);
    if (typeof value === 'string') select.setDefaultChannels(value);
    else if (Array.isArray(value) && value.length > 0) select.setDefaultChannels(...(value as string[]));
    return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select).toJSON();
  };

  const text = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

  return {
    content: [
      '**Camelot setup**',
      'Pick your channels. Everything else has a default you can change later.',
      '',
      `Games panel — ${formatChannel(settings.channels.panel)}`,
      `Clips — ${formatChannel(settings.channels.clips)}`,
      `Weekly winner — ${settings.channels.highlights ? formatChannel(settings.channels.highlights) : '*same as clips*'}`,
      `Voice — ${
        settings.voice.eligible.length > 0
          ? settings.voice.eligible.map((id) => `<#${id}>`).join(' ')
          : '*any public VC*'
      }`,
    ].join('\n'),
    components: [
      picker('channels.panel', 'Games panel', text, 1),
      picker('channels.clips', 'Clips', text, 1),
      picker('channels.highlights', 'Weekly winner (optional)', text, 1),
      picker('voice.eligible', 'Voice channels (optional — order sets priority)', [ChannelType.GuildVoice], 25),
    ],
  };
}

function formatChannel(id: string | null): string {
  return id ? `<#${id}>` : '*not set*';
}
