import { SlashCommandBuilder } from 'discord.js';
import { COMMANDS, type CommandSpec } from './registry.js';

/**
 * Built straight from the registry, so what Discord registers and what `/help`
 * lists can never disagree. An alias is registered as its own command with the
 * same shape — Discord has no notion of an alias — and the router maps it back
 * to one handler.
 */
function build(spec: CommandSpec, name: string): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName(name)
    .setDescription(spec.description)
    .setDMPermission(false);

  if (spec.defaultPermission !== undefined) builder.setDefaultMemberPermissions(spec.defaultPermission);

  if (spec.userOption) {
    builder.addUserOption((option) =>
      option
        .setName(spec.userOption!.name)
        .setDescription(spec.userOption!.description)
        .setRequired(false),
    );
  }

  return builder;
}

export function buildCommands(): SlashCommandBuilder[] {
  return COMMANDS.flatMap((spec) => [spec.name, ...(spec.aliases ?? [])].map((name) => build(spec, name)));
}
