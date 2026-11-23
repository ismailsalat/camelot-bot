type Level = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let current: Level = 'info';

export function setLogLevel(level: Level): void {
  current = level;
}

function emit(level: Level, args: unknown[]): void {
  if (ORDER[level] > ORDER[current]) return;
  const stamp = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5, ' ');
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(`${stamp} ${tag} ${args.map(fmt).join(' ')}`);
}

function fmt(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  error: (...args: unknown[]) => emit('error', args),
  warn: (...args: unknown[]) => emit('warn', args),
  info: (...args: unknown[]) => emit('info', args),
  debug: (...args: unknown[]) => emit('debug', args),
};
