import {
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type GuildMember,
} from 'discord.js';
import { getSettings } from '../db/settings.js';
import { button, container, divider, heading, row, selectRow, text } from './ui.js';
import { Ids } from './ids.js';
import { tierOf } from './permissions.js';
import {
  COMMANDS,
  MODULES,
  commandsFor,
  isModuleEnabled,
  moduleByKey,
  tierAllows,
  type ModuleKey,
} from './registry.js';
import { emojiFor } from '../util/emoji.js';

/**
 * Help is generated from the registry, never hand-written, so it cannot drift
 * from what the bot actually does. Add a command to the registry and it shows
 * up here; remove it and it disappears.
 */

export function renderHelpHome(member: GuildMember, client?: Client) {
  const settings = getSettings(member.guild.id);
  const tier = tierOf(member);

  const modules = MODULES.filter((module) => module.key !== 'core' && isModuleEnabled(settings, module.key));

  const body = container()
    .addTextDisplayComponents(heading(`${emojiFor(settings, 'crown', client)}  CAMELOT`, 'Everything you need.'))
    .addSeparatorComponents(divider());

  for (const module of modules) {
    const commands = commandsFor(module.key).filter((command) => tierAllows(tier, command.tier));
    const line = commands.length > 0 ? commands.map((command) => `\`/${command.name}\``).join(' ') : '_Automatic_';
    body.addTextDisplayComponents(text(`**${module.name}**\n${module.blurb}\n${line}`));
  }

  const core = commandsFor('core').filter((command) => tierAllows(tier, command.tier));
  if (core.length > 0) {
    body.addTextDisplayComponents(
      text(`**Settings**\nChange how Camelot works.\n${core.map((c) => `\`/${c.name}\``).join(' ')}`),
    );
  }

  const options = modules
    .filter((module) => commandsFor(module.key).some((command) => tierAllows(tier, command.tier)))
    .map((module) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(module.name)
        .setValue(module.key)
        .setDescription(module.blurb.slice(0, 100)),
    );

  if (options.length > 0) {
    body
      .addSeparatorComponents(divider())
      .addActionRowComponents(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(Ids.helpCategory())
            .setPlaceholder('Want more detail?')
            .addOptions(options),
        ),
      );
  }

  return body;
}

export function renderHelpCategory(member: GuildMember, key: ModuleKey) {
  const settings = getSettings(member.guild.id);
  const tier = tierOf(member);
  const module = moduleByKey(key);
  const commands = commandsFor(key).filter((command) => tierAllows(tier, command.tier));

  const body = container()
    .addTextDisplayComponents(heading(module.name.toUpperCase(), module.blurb))
    .addSeparatorComponents(divider());

  if (commands.length === 0) {
    body.addTextDisplayComponents(text('Runs on its own — no commands needed.'));
  } else {
    for (const command of commands) {
      const suffix = command.tier === 'member' ? '' : command.tier === 'owner' ? ' · owner only' : ' · admin only';
      body.addTextDisplayComponents(text(`\`/${command.name}\`${suffix}\n${command.description}`));
    }
  }

  const group = commands.find((command) => command.settingsGroup)?.settingsGroup ?? module.settingsGroups[0];
  if (group && (tier === 'admin' || tier === 'owner')) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(`Settings for this live in \`/settings\` → **${groupLabel(group)}**.`));
  }

  body.addActionRowComponents(row(button(Ids.helpHome(), 'Back', ButtonStyle.Secondary)));
  return body;
}

export function groupLabel(group: string): string {
  const labels: Record<string, string> = {
    modules: 'Modules',
    channels: 'Channels',
    clips: 'Clips',
    activity: 'Activity',
    purge: 'The Purge',
    permissions: 'Permissions',
    emojis: 'Emojis',
    status: 'Bot Status',
  };
  return labels[group] ?? group;
}

/** Used by the register script so Discord's list matches the registry exactly. */
export function knownCommandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}
