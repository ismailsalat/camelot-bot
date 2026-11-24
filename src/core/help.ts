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
  allCommandNames,
  commandLabel,
  commandsFor,
  isModuleEnabled,
  moduleByKey,
  tierAllows,
  type ModuleKey,
} from './registry.js';
import { prefixFor, textCommandsEnabled } from './prefix.js';
import { emojiFor } from '../util/emoji.js';

/**
 * Help is generated from the registry, never hand-written, so it cannot drift
 * from what the bot actually does. Add a command to the registry and it shows
 * up here; remove it and it disappears.
 */

export function renderHelpHome(member: GuildMember, client?: Client) {
  const settings = getSettings(member.guild.id);
  const tier = tierOf(member);

  const modules = MODULES.filter((module) => module.key !== 'core' && (module.key === 'streaming' || isModuleEnabled(settings, module.key)));

  const body = container()
    .addTextDisplayComponents(heading(`${emojiFor(settings, 'crown', client)}  CAMELOT`, 'Everything you need.'))
    .addSeparatorComponents(divider());

  for (const module of modules) {
    const commands = commandsFor(module.key).filter((command) => tierAllows(tier, command.tier));
    const line = commands.length > 0 ? commands.map((command) => commandLabel(command)+(command.name==='stream'?' · `!stream`':'')).join('  ') : commandsFor(module.key).length ? '_Admin only_' : '_Automatic_';
    const status = isModuleEnabled(settings, module.key) ? '' : ' · Off';
    body.addTextDisplayComponents(text(`**${module.name}${status}**\n${module.blurb}\n${line}`));
  }

  const core = commandsFor('core').filter((command) => tierAllows(tier, command.tier));
  if (core.length > 0) {
    body.addTextDisplayComponents(
      text(`**Help & settings**\n${core.map((command) => `${commandLabel(command)} · ${command.description}`).join('\n')}`),
    );
  }

  const options = modules
    .filter((module) => !commandsFor(module.key).length || commandsFor(module.key).some((command) => tierAllows(tier, command.tier)))
    .map((module) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(module.name)
        .setValue(module.key)
        .setDescription(module.blurb.slice(0, 100)),
    );

  if (textCommandsEnabled(member.guild.id) && isModuleEnabled(settings, 'activity')) {
    const prefix = prefixFor(member.guild.id);
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(`Typing is faster: \`${prefix}allies\` works the same as \`/activity\`, and takes an @mention too.`),
      );
  }

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
  if (!module) return renderHelpHome(member);
  const commands = commandsFor(key).filter((command) => tierAllows(tier, command.tier));

  const body = container()
    .addTextDisplayComponents(heading(module.name.toUpperCase(), module.blurb))
    .addSeparatorComponents(divider());

  if (commands.length === 0) {
    body.addTextDisplayComponents(text(commandsFor(key).length ? 'These controls are for admins.' : 'Runs on its own. No commands needed.'));
  } else {
    const prefix = prefixFor(member.guild.id);
    const textOn = textCommandsEnabled(member.guild.id);
    for (const command of commands) {
      const suffix = command.tier === 'member' ? '' : command.tier === 'owner' ? ' · owner only' : ' · admin only';
      const lines = [`${commandLabel(command)}${suffix}`, command.description];
      if (textOn && !command.slashOnly) {
        lines.push(
          command.textNeedsTarget
            ? `_Or_ \`${prefix}${command.name} @someone\``
            : `_Or_ ${commandLabel(command, prefix)}`,
        );
      }
      // Skipped when the text form above already shows the @mention, to avoid
      // saying the same thing twice in four lines.
      if (command.userOption && !(textOn && command.textNeedsTarget)) {
        lines.push(`_Add an @mention to aim it at someone: \`/${command.name} @someone\`_`);
      }
      body.addTextDisplayComponents(text(lines.join('\n')));
    }
  }

  if (key === 'streaming') {
    body.addTextDisplayComponents(text(isModuleEnabled(settings, key)
      ? 'Join a voice channel → `/stream` or `!stream` → **Find anime** → **Play**. The controls appear in that VC’s chat.'
      : 'Streaming is off. An admin can turn it on in `/settings` → **Streaming**, then save the account there.'));
    body.addTextDisplayComponents(text('If /stream is missing from Discord’s menu, type **!stream** in chat. This fallback also works with text commands turned off.'));
    body.addTextDisplayComponents(text('**Playback**\nPrevious ep · Next ep · Stop · Play/Pause\nBack 30 sec · Forward 30 sec · Custom time\nChoose a source from the dropdown if playback fails.'));
    body.addTextDisplayComponents(text('**Taking turns**\nOne person controls the stream. **My turn** joins the queue. **Stop** ends the session and frees the next turn.'));
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
    streaming: 'Streaming',
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
  return allCommandNames();
}

void COMMANDS;
