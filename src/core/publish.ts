import { createHash } from 'node:crypto';
import { REST, Routes } from 'discord.js';
import { buildCommands } from './commands.js';
import { meta } from '../db/index.js';
import { log } from '../logger.js';

/**
 * Publishes the slash commands at boot, but only when they have actually
 * changed.
 *
 * Registration used to be a separate script. On a host where you cannot easily
 * run a one-off command, that meant a new command simply never appeared and
 * the only symptom was its absence — nothing in the logs, nothing broken, just
 * a command that wasn't there. So the bot now checks its own work.
 *
 * The fingerprint is of the full payload, not the names, so adding an option
 * to an existing command republishes too. Unchanged deployments make no API
 * call at all, which keeps restarts clear of Discord's daily limit on global
 * command writes.
 */

const KEY = 'commands.fingerprint';

export interface PublishResult {
  published: boolean;
  count: number;
  reason: 'unchanged' | 'changed' | 'first-run' | 'failed';
}

function fingerprint(payload: unknown, scope: string): string {
  return createHash('sha256').update(`${scope}\n${JSON.stringify(payload)}`).digest('hex').slice(0, 32);
}

export async function publishCommands(options: {
  clientId: string;
  token: string;
  devGuildId?: string;
}): Promise<PublishResult> {
  const body = buildCommands().map((command) => command.toJSON());
  const scope = options.devGuildId ? `guild:${options.devGuildId}` : 'global';
  const next = fingerprint(body, scope);
  const previous = meta.get(KEY);

  if (previous === next) {
    log.debug(`Slash commands unchanged (${body.length}).`);
    return { published: false, count: body.length, reason: 'unchanged' };
  }

  const rest = new REST({ version: '10' }).setToken(options.token);
  const names = body.map((command) => command.name).join(', ');

  try {
    if (options.devGuildId) {
      await rest.put(Routes.applicationGuildCommands(options.clientId, options.devGuildId), { body });
      // Clear globals so a command cannot linger in two places at once.
      await rest.put(Routes.applicationCommands(options.clientId), { body: [] });
      log.info(`Published ${body.length} command(s) to guild ${options.devGuildId}: ${names}`);
    } else {
      await rest.put(Routes.applicationCommands(options.clientId), { body });
      log.info(`Published ${body.length} command(s) globally: ${names}`);
    }
    // Written only after Discord has accepted them, so a failed publish is
    // retried on the next boot rather than remembered as done.
    meta.set(KEY, next);
    return { published: true, count: body.length, reason: previous === null ? 'first-run' : 'changed' };
  } catch (error) {
    // Not fatal: the commands already registered keep working, and the next
    // boot tries again.
    log.error('Could not publish slash commands — existing ones still work', error);
    return { published: false, count: body.length, reason: 'failed' };
  }
}

/** Exposed so a test can assert the fingerprint moves when the commands do. */
export function commandFingerprint(devGuildId?: string): string {
  return fingerprint(
    buildCommands().map((command) => command.toJSON()),
    devGuildId ? `guild:${devGuildId}` : 'global',
  );
}
