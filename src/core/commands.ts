import { SlashCommandBuilder } from 'discord.js';
import { COMMANDS } from './registry.js';

/**
 * Built straight from the registry, so what Discord registers and what `/help`
 * lists can never disagree.
 */
export function buildCommands(): SlashCommandBuilder[] {
  return COMMANDS.map((spec) => {
    const builder = new SlashCommandBuilder()
      .setName(spec.name)
      .setDescription(spec.description)
      .setDMPermission(false);
    if (spec.defaultPermission !== undefined) builder.setDefaultMemberPermissions(spec.defaultPermission);
    return builder;
  });
}
