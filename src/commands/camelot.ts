import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { enabledGames, getSettings } from '../db/settings.js';
import { diagnose } from '../features/diagnose.js';
import { postPanel } from '../features/panel.js';
import { renderSettingsHome, renderSetup } from '../ui/settingsUi.js';
import { DAY_NAMES } from '../util/time.js';

export const camelotCommand = new SlashCommandBuilder()
  .setName('camelot')
  .setDescription('Set up and tune Camelot')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) => sub.setName('setup').setDescription('Pick the channels Camelot should use'))
  .addSubcommand((sub) => sub.setName('settings').setDescription('Change any Camelot setting'))
  .addSubcommand((sub) => sub.setName('panel').setDescription('Post or refresh the pinned games panel'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Check Camelot is set up right'));

export async function handleCamelotCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'Use this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const settings = getSettings(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === 'setup') {
    await interaction.reply({ ...renderSetup(settings), flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'settings') {
    await interaction.reply({ ...renderSettingsHome(settings), flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'panel') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await postPanel(interaction.guild, true);
    await interaction.editReply(
      message
        ? `Panel's up in <#${message.channelId}>.`
        : "Couldn't post it. Check the games panel channel in `/camelot setup`, and that I can post there.",
    );
    return;
  }

  // status — read-only on purpose; it changes nothing.
  const findings = diagnose(interaction.guild, settings);
  const blocked = findings.filter((entry) => entry.level === 'blocked');
  const notes = findings.filter((entry) => entry.level === 'heads-up');

  const lines = [
    '**Camelot**',
    `Panel ${channelOrNone(settings.channels.panel)} · Clips ${channelOrNone(settings.channels.clips)} · Winner ${channelOrNone(
      settings.channels.highlights ?? settings.channels.clips,
    )}`,
    `${settings.weekly.title}: ${DAY_NAMES[settings.weekly.dayOfWeek] ?? 'Friday'} ${settings.weekly.time} (${settings.timezone})`,
    `Games: ${enabledGames(settings).map((game) => game.name).join(', ') || 'none'}`,
    `Voice: ${
      settings.voice.eligible.length > 0
        ? settings.voice.eligible.map((id) => `<#${id}>`).join(' ')
        : 'any public VC'
    }`,
  ];

  if (blocked.length > 0) lines.push('', '**Needs fixing**', ...blocked.map((entry) => `• ${entry.text}`));
  if (notes.length > 0) lines.push('', '**Worth knowing**', ...notes.map((entry) => `• ${entry.text}`));
  if (findings.length === 0) lines.push('', 'All good.');

  await interaction.reply({
    content: lines.join('\n').slice(0, 1900),
    flags: MessageFlags.Ephemeral,
  });
}

function channelOrNone(id: string | null): string {
  return id ? `<#${id}>` : '*not set*';
}
