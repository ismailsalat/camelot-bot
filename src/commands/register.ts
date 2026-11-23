/**
 * Publishes the slash commands. Because the list comes from the registry, a
 * command removed from the code disappears from Discord on the next run —
 * `put` replaces the whole set rather than adding to it.
 *
 *   npm run register         (dev)
 *   npm run register:prod    (after npm run build)
 */
import { REST, Routes } from 'discord.js';
import { loadEnv } from '../env.js';
import { buildCommands } from '../core/commands.js';
import { log, setLogLevel } from '../logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel);

  const rest = new REST({ version: '10' }).setToken(env.token);
  const body = buildCommands().map((command) => command.toJSON());

  if (env.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(env.clientId, env.devGuildId), { body });
    log.info(`Registered ${body.length} command(s) to guild ${env.devGuildId}: ${body.map((c) => c.name).join(', ')}`);
    // Clear any globals left over from an earlier layout.
    await rest.put(Routes.applicationCommands(env.clientId), { body: [] });
    log.info('Cleared global commands (dev guild mode).');
  } else {
    await rest.put(Routes.applicationCommands(env.clientId), { body });
    log.info(`Registered ${body.length} command(s) globally: ${body.map((c) => c.name).join(', ')}`);
  }
}

main().catch((error) => {
  log.error('Command registration failed', error);
  process.exit(1);
});
