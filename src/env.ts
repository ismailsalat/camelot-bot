import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in (see README.md).`,
    );
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

export interface Env {
  token: string;
  clientId: string;
  devGuildId?: string;
  databasePath: string;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  /** Default prefix for text commands. Each server's owner can override it. */
  commandPrefix: string;
}

export const DEFAULT_PREFIX = '!';

/**
 * Punctuation only, one to three characters. A letter or digit would turn
 * ordinary sentences into commands, and `/`, `@`, `#`, `<` and backtick all
 * mean something to Discord before Camelot ever sees the message.
 */
const PREFIX_SHAPE = /^[!?.$%^&*\-_=+~|;:,'"()[\]{}]{1,3}$/;

export function isValidPrefix(value: string): boolean {
  return PREFIX_SHAPE.test(value);
}

export function readPrefix(raw: string | undefined, warn?: (message: string) => void): string {
  if (raw === undefined) return DEFAULT_PREFIX;
  if (isValidPrefix(raw)) return raw;
  warn?.(
    `COMMAND_PREFIX "${raw}" is not usable — it must be 1-3 punctuation characters ` +
      `and cannot use / @ # < or a backtick. Falling back to "${DEFAULT_PREFIX}".`,
  );
  return DEFAULT_PREFIX;
}

export function loadEnv(): Env {
  const databasePath = resolve(optional('DATABASE_PATH') ?? './data/camelot.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });

  const rawLevel = (optional('LOG_LEVEL') ?? 'info').toLowerCase();
  const logLevel = (['error', 'warn', 'info', 'debug'].includes(rawLevel) ? rawLevel : 'info') as Env['logLevel'];

  // Read before the logger is configured, so the warning goes to stderr plainly.
  const commandPrefix = readPrefix(optional('COMMAND_PREFIX'), (message) =>
    console.warn(`\u26a0\ufe0f  ${message}`),
  );

  return {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    devGuildId: optional('DEV_GUILD_ID'),
    databasePath,
    logLevel,
    commandPrefix,
  };
}
