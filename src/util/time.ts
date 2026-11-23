/**
 * Small timezone helpers built on Intl — no date library needed.
 * Everything in the bot stores epoch milliseconds; only display and
 * "what time did the user mean" conversions happen here.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24, // some locales report 24 at midnight
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: Math.max(0, WEEKDAYS.indexOf(map.weekday ?? 'Sun')),
  };
}

/** Offset of `timeZone` from UTC, in ms, at the given instant. */
function offsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - ms;
}

/** Turn a wall-clock time in `timeZone` into epoch ms (DST-aware). */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = naive - offsetMs(naive, timeZone);
  const second = naive - offsetMs(first, timeZone);
  return second;
}

/** "HH:MM" -> {hour, minute}; tolerant of "9:5", "09:05", "7". */
export function parseHhMm(value: string): { hour: number; minute: number } | null {
  const match = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Parse what a member typed into the "custom time" box.
 * Accepts: "9:30pm", "9pm", "21:30", "+45", "45m", "in 45 min", "1h", "1h30".
 * Absolute times resolve to the next future occurrence in `timeZone`.
 * Returns epoch ms, or null if it could not be understood.
 */
export function parseTimeInput(raw: string, timeZone: string, now = Date.now()): number | null {
  const input = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!input) return null;

  // Relative: +45, 45m, in 45, in 1h30, 2 hours
  const relative = /^(?:in\s*)?\+?(?:(\d{1,3})\s*h(?:ours?|rs?)?)?\s*(?:(\d{1,3})\s*(?:m(?:in(?:ute)?s?)?)?)?$/.exec(
    input,
  );
  if (relative && (relative[1] || relative[2]) && /^(?:in\s|\+|\d)/.test(input)) {
    const hours = Number(relative[1] ?? 0);
    const minutes = Number(relative[2] ?? 0);
    const total = hours * 60 + minutes;
    // A bare number like "930" is a time, not 930 minutes.
    const looksLikeClock = !relative[1] && /^\d{3,4}$/.test(input);
    if (!looksLikeClock && total > 0 && total <= 24 * 60) {
      return now + total * 60_000;
    }
  }

  // Absolute: 9:30pm / 9 pm / 21:30 / 930pm
  const absolute = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/.exec(input);
  if (!absolute) return null;

  let hour = Number(absolute[1]);
  const minute = Number(absolute[2] ?? '0');
  const meridiem = absolute[3];

  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  const today = zonedParts(now, timeZone);
  let when = zonedToUtc(today.year, today.month, today.day, hour, minute, timeZone);
  if (when <= now + 30_000) {
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day) + 86_400_000);
    when = zonedToUtc(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return when;
}

/** Next occurrence of `dayOfWeek` at "HH:MM" local time, strictly after `from`. */
export function nextWeeklyOccurrence(
  dayOfWeek: number,
  hhmm: string,
  timeZone: string,
  from = Date.now(),
): number {
  const time = parseHhMm(hhmm) ?? { hour: 20, minute: 0 };
  const base = zonedParts(from, timeZone);
  for (let offset = 0; offset <= 7; offset += 1) {
    const probeUtcMidday = Date.UTC(base.year, base.month - 1, base.day) + offset * 86_400_000;
    const probe = new Date(probeUtcMidday);
    const candidateParts = {
      year: probe.getUTCFullYear(),
      month: probe.getUTCMonth() + 1,
      day: probe.getUTCDate(),
    };
    const candidate = zonedToUtc(
      candidateParts.year,
      candidateParts.month,
      candidateParts.day,
      time.hour,
      time.minute,
      timeZone,
    );
    if (zonedParts(candidate, timeZone).weekday !== dayOfWeek) continue;
    if (candidate > from) return candidate;
  }
  // Fallback: a week from now at that time.
  return from + 7 * 86_400_000;
}

/** Stable key for the week a weekly run belongs to, e.g. "2026-W47". */
export function weekKey(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  const date = Date.UTC(p.year, p.month - 1, p.day);
  const dayNumber = new Date(date).getUTCDay();
  const thursday = date + ((dayNumber === 0 ? -3 : 4 - dayNumber) * 86_400_000);
  const thursdayDate = new Date(thursday);
  const yearStart = Date.UTC(thursdayDate.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday - yearStart) / (7 * 86_400_000)) + 1;
  return `${thursdayDate.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function isWithinQuietHours(ms: number, timeZone: string, start: string, end: string): boolean {
  const s = parseHhMm(start);
  const e = parseHhMm(end);
  if (!s || !e) return false;
  const now = zonedParts(ms, timeZone);
  const minutes = now.hour * 60 + now.minute;
  const from = s.hour * 60 + s.minute;
  const to = e.hour * 60 + e.minute;
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** Discord renders these in each viewer's own local time. */
export function discordTime(ms: number, style: 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R' = 't'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
