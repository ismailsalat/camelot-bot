import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  discordTime,
  isWithinQuietHours,
  nextWeeklyOccurrence,
  parseHhMm,
  parseTimeInput,
  weekKey,
  zonedParts,
  zonedToUtc,
} from '../util/time.js';

const TZ = 'America/Los_Angeles';

describe('time handling', () => {
  it('converts a wall-clock time in a zone back to an instant', () => {
    // 2026-11-18 21:30 PST === 2026-11-19 05:30 UTC
    const ms = zonedToUtc(2026, 11, 18, 21, 30, TZ);
    assert.equal(new Date(ms).toISOString(), '2026-11-19T05:30:00.000Z');
  });

  it('survives a DST boundary', () => {
    // PDT -> PST happened 2026-11-01. Both sides should round-trip.
    for (const [month, day] of [
      [10, 25],
      [11, 8],
    ] as const) {
      const ms = zonedToUtc(2026, month, day, 20, 0, TZ);
      const parts = zonedParts(ms, TZ);
      assert.equal(parts.hour, 20, `${month}/${day}`);
      assert.equal(parts.minute, 0);
    }
  });

  it('parses the custom-time box the way members type it', () => {
    const now = zonedToUtc(2026, 11, 18, 18, 0, TZ); // 6pm local
    const cases: [string, string][] = [
      ['9:30pm', '2026-11-19T05:30:00.000Z'],
      ['21:30', '2026-11-19T05:30:00.000Z'],
      ['9pm', '2026-11-19T05:00:00.000Z'],
      ['930pm', '2026-11-19T05:30:00.000Z'],
    ];
    for (const [input, expected] of cases) {
      const parsed = parseTimeInput(input, TZ, now);
      assert.ok(parsed, input);
      assert.equal(new Date(parsed).toISOString(), expected, input);
    }
  });

  it('rolls an already-past time to tomorrow', () => {
    const now = zonedToUtc(2026, 11, 18, 22, 0, TZ); // 10pm local
    const parsed = parseTimeInput('9:00am', TZ, now)!;
    assert.equal(zonedParts(parsed, TZ).day, 19);
  });

  it('understands relative times', () => {
    const now = Date.UTC(2026, 10, 18, 2, 0, 0);
    assert.equal(parseTimeInput('in 45', TZ, now), now + 45 * 60_000);
    assert.equal(parseTimeInput('+45m', TZ, now), now + 45 * 60_000);
    assert.equal(parseTimeInput('1h30', TZ, now), now + 90 * 60_000);
    assert.equal(parseTimeInput('2 hours', TZ, now), now + 120 * 60_000);
  });

  it('rejects nonsense instead of guessing', () => {
    assert.equal(parseTimeInput('later maybe', TZ), null);
    assert.equal(parseTimeInput('25:99', TZ), null);
    assert.equal(parseTimeInput('', TZ), null);
  });

  it('finds the next Friday at the configured time', () => {
    const from = zonedToUtc(2026, 11, 18, 12, 0, TZ); // a Wednesday
    const next = nextWeeklyOccurrence(5, '20:00', TZ, from);
    const parts = zonedParts(next, TZ);
    assert.equal(parts.weekday, 5);
    assert.equal(parts.hour, 20);
    assert.equal(parts.day, 20);
  });

  it('moves to next week when today is already past the time', () => {
    const friday9pm = zonedToUtc(2026, 11, 20, 21, 0, TZ);
    const next = nextWeeklyOccurrence(5, '20:00', TZ, friday9pm);
    assert.equal(zonedParts(next, TZ).day, 27);
  });

  it('gives one stable key per week so a restart cannot double-announce', () => {
    const friday = zonedToUtc(2026, 11, 20, 20, 0, TZ);
    assert.equal(weekKey(friday, TZ), weekKey(friday + 3_600_000, TZ));
    assert.notEqual(weekKey(friday, TZ), weekKey(friday + 7 * 86_400_000, TZ));
  });

  it('handles quiet hours that wrap past midnight', () => {
    const at = (hour: number) => zonedToUtc(2026, 11, 18, hour, 0, TZ);
    assert.equal(isWithinQuietHours(at(23), TZ, '23:00', '09:00'), true);
    assert.equal(isWithinQuietHours(at(3), TZ, '23:00', '09:00'), true);
    assert.equal(isWithinQuietHours(at(12), TZ, '23:00', '09:00'), false);
    assert.equal(isWithinQuietHours(at(12), TZ, '09:00', '17:00'), true);
  });

  it('formats Discord timestamps so everyone sees their own local time', () => {
    assert.equal(discordTime(1_763_522_000_000, 't'), '<t:1763522000:t>');
  });

  it('parses HH:MM', () => {
    assert.deepEqual(parseHhMm('20:00'), { hour: 20, minute: 0 });
    assert.deepEqual(parseHhMm('9'), { hour: 9, minute: 0 });
    assert.equal(parseHhMm('24:00'), null);
  });
});
