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
}

export function loadEnv(): Env {
  const databasePath = resolve(optional('DATABASE_PATH') ?? './data/camelot.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });

  const rawLevel = (optional('LOG_LEVEL') ?? 'info').toLowerCase();
  const logLevel = (['error', 'warn', 'info', 'debug'].includes(rawLevel) ? rawLevel : 'info') as Env['logLevel'];

  return {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    devGuildId: optional('DEV_GUILD_ID'),
    databasePath,
    logLevel,
  };
}
