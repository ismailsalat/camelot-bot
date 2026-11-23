import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { openTestDatabase } from '../db/index.js';
import { DEFAULT_SETTINGS, clearSettingsCache, type GuildSettings } from '../db/settings.js';
import { dayKey, recentDays, store, textChannelCounts, voiceChannelCounts, FULL_COVERAGE_SECONDS } from '../activity/store.js';
import { summarise } from '../activity/summary.js';

const ref = (id: string, parentId: string | null = null) => ({ id, parentId });

const GUILD = 'g1';
const USER = 'u1';
const TZ = 'America/Los_Angeles';

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
});

const settings = (patch: Partial<GuildSettings['activity']> = {}): GuildSettings => ({
  ...DEFAULT_SETTINGS,
  activity: { ...DEFAULT_SETTINGS.activity, ...patch },
});

describe('message counting', () => {
  const limits = { dailyCap: 12, cooldownSeconds: 30 };

  it('counts a message and respects the daily cap', () => {
    const day = '2026-11-20';
    let at = Date.UTC(2026, 10, 20, 12, 0, 0);
    let counted = 0;
    for (let i = 0; i < 20; i += 1) {
      if (store.countMessage(GUILD, USER, day, at, limits)) counted += 1;
      at += 60_000; // a minute apart, so the cooldown never blocks
    }
    assert.equal(counted, 12, 'stops at the cap');
  });

  it('ignores rapid-fire bursts', () => {
    const day = '2026-11-20';
    const at = Date.UTC(2026, 10, 20, 12, 0, 0);
    assert.equal(store.countMessage(GUILD, USER, day, at, limits), true);
    assert.equal(store.countMessage(GUILD, USER, day, at + 1000, limits), false, 'one second later');
    assert.equal(store.countMessage(GUILD, USER, day, at + 29_000, limits), false, 'still inside the window');
    assert.equal(store.countMessage(GUILD, USER, day, at + 31_000, limits), true, 'past the window');
  });

  it('keeps separate counters per day and per member', () => {
    const at = Date.UTC(2026, 10, 20, 12, 0, 0);
    store.countMessage(GUILD, USER, '2026-11-20', at, limits);
    store.countMessage(GUILD, USER, '2026-11-21', at, limits);
    store.countMessage(GUILD, 'u2', '2026-11-20', at, limits);

    const mine = store.dailyFor(GUILD, USER, ['2026-11-20', '2026-11-21']);
    assert.equal(mine.get('2026-11-20')?.messages, 1);
    assert.equal(mine.get('2026-11-21')?.messages, 1);
    assert.equal(store.dailyFor(GUILD, 'u2', ['2026-11-20']).get('2026-11-20')?.messages, 1);
  });
});

describe('channel eligibility', () => {
  it('falls back to #general when nothing is configured', () => {
    assert.equal(textChannelCounts(settings(), ref('GEN'), 'GEN'), true);
    assert.equal(textChannelCounts(settings(), ref('OTHER'), 'GEN'), false);
    assert.equal(textChannelCounts(settings(), ref('ANY'), null), false, 'no general, nothing counts');
  });

  it('uses the configured list once there is one', () => {
    const s = settings({ textChannels: ['A', 'B'] });
    assert.equal(textChannelCounts(s, ref('A'), 'GEN'), true);
    assert.equal(textChannelCounts(s, ref('GEN'), 'GEN'), false, 'general stops being special');
  });

  it('always honours the ignore list', () => {
    const s = settings({ textChannels: ['A'], ignoredChannels: ['A'] });
    assert.equal(textChannelCounts(s, ref('A'), null), false);
  });

  it('counts every voice channel except AFK by default', () => {
    assert.equal(voiceChannelCounts(settings(), ref('VC'), 'AFK'), true);
    assert.equal(voiceChannelCounts(settings(), ref('AFK'), 'AFK'), false);
    assert.equal(
      voiceChannelCounts(settings({ voiceMode: 'only', voiceChannels: ['VC1'] }), 'VC2', null),
      false,
      'in "only" mode an unlisted channel is out',
    );
  });
});

describe('voice sessions', () => {
  it('opens once and closes with the time it was open', () => {
    const start = Date.now() - 600_000;
    store.openVoice(GUILD, USER, 'VC', start);
    store.openVoice(GUILD, USER, 'VC', start + 1000); // duplicate join is a no-op
    assert.equal(store.hasOpenVoice(GUILD, USER), true);

    const closed = store.closeVoice(GUILD, USER);
    assert.equal(closed?.startedAt, start, 'kept the original start time');
    assert.equal(store.hasOpenVoice(GUILD, USER), false);
    assert.equal(store.closeVoice(GUILD, USER), null, 'closing twice is harmless');
  });

  it('drops open sessions at boot rather than inventing hours', () => {
    store.openVoice(GUILD, USER, 'VC', Date.now() - 86_400_000);
    assert.equal(store.clearOpenVoice(), 1);
    assert.equal(store.hasOpenVoice(GUILD, USER), false);
    assert.equal(store.dailyFor(GUILD, USER, recentDays(2, TZ)).size, 0, 'no time was credited');
  });
});

describe('day keys and coverage', () => {
  it('uses the server timezone, not UTC', () => {
    // 2026-11-21 04:00 UTC is still the 20th in Los Angeles.
    assert.equal(dayKey(Date.UTC(2026, 10, 21, 4, 0, 0), TZ), '2026-11-20');
    assert.equal(dayKey(Date.UTC(2026, 10, 21, 4, 0, 0), 'UTC'), '2026-11-21');
  });

  it('returns the window oldest first, ending today', () => {
    const days = recentDays(3, TZ, Date.UTC(2026, 10, 21, 20, 0, 0));
    assert.deepEqual(days, ['2026-11-19', '2026-11-20', '2026-11-21']);
  });

  it('accumulates coverage and never exceeds a full day', () => {
    store.addCoverage(GUILD, '2026-11-20', 40_000);
    store.addCoverage(GUILD, '2026-11-20', 40_000);
    store.addCoverage(GUILD, '2026-11-20', 40_000);
    assert.equal(store.coverageFor(GUILD, ['2026-11-20']).get('2026-11-20'), 86_400);
  });
});

describe('summaries', () => {
  const now = Date.UTC(2026, 10, 21, 20, 0, 0);

  function seed(dayOffsets: { offset: number; messages?: number; voiceMinutes?: number }[], coverDays = 30) {
    const days = recentDays(30, TZ, now);
    for (let i = 0; i < coverDays; i += 1) {
      const day = days[days.length - 1 - i];
      if (day) store.addCoverage(GUILD, day, 86_400);
    }
    for (const entry of dayOffsets) {
      const day = days[days.length - 1 - entry.offset]!;
      if (entry.messages) {
        for (let i = 0; i < entry.messages; i += 1) {
          store.countMessage(GUILD, USER, day, now - entry.offset * 86_400_000 + i * 120_000, {
            dailyCap: 50,
            cooldownSeconds: 0,
          });
        }
      }
      if (entry.voiceMinutes) store.addVoiceSeconds(GUILD, USER, day, entry.voiceMinutes * 60);
    }
  }

  it('counts an active day from voice or from messages', () => {
    seed([
      { offset: 1, voiceMinutes: 20 }, // over the 15-minute bar
      { offset: 2, messages: 5 }, // exactly the message bar
      { offset: 3, voiceMinutes: 5 }, // under both
    ]);
    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.equal(summary.activeDays, 2);
  });

  it('separates real voice time from the capped score', () => {
    seed([{ offset: 1, voiceMinutes: 600 }]); // ten hours in one day
    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.equal(summary.voiceSeconds, 600 * 60, 'shows what actually happened');
    assert.equal(summary.scoredVoiceSeconds, 180 * 60, 'scores only the daily cap');
  });

  it('marks untracked days differently from quiet ones', () => {
    seed([{ offset: 1, voiceMinutes: 30 }], 5); // only five days covered
    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.ok(summary.timeline.includes('unknown'), 'days with no coverage are unknown');
    assert.ok(summary.timeline.includes('active'));
    assert.equal(summary.timeline.length, 30);
    assert.ok(summary.observedDays < 30);
  });

  it('never treats today as fully observed', () => {
    seed([], 30);
    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.ok(summary.observedDays <= 29, 'today is still in progress');
  });

  it('flags provisional results while tracking is young', () => {
    seed([{ offset: 1, messages: 6 }], 3);
    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.equal(summary.provisional, true);
  });

  it('reports no activity honestly rather than as zero days ago', () => {
    seed([], 30);
    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.equal(summary.lastActiveDay, null);
    assert.equal(summary.daysSinceActive, null);
    assert.equal(summary.score, 0);
  });
});

describe('retention', () => {
  it('prunes old days and leaves recent ones', () => {
    const now = Date.UTC(2026, 10, 21, 12, 0, 0);
    store.addVoiceSeconds(GUILD, USER, '2026-01-01', 600);
    store.addVoiceSeconds(GUILD, USER, dayKey(now, TZ), 600);
    store.addCoverage(GUILD, '2026-01-01', FULL_COVERAGE_SECONDS);

    store.prune(GUILD, 30, TZ, now);

    assert.equal(store.dailyFor(GUILD, USER, ['2026-01-01']).size, 0);
    assert.equal(store.dailyFor(GUILD, USER, [dayKey(now, TZ)]).size, 1);
  });

  it('wipes only activity data', () => {
    store.addVoiceSeconds(GUILD, USER, '2026-11-20', 600);
    store.openVoice(GUILD, USER, 'VC', Date.now());
    store.wipe(GUILD);
    assert.equal(store.dailyFor(GUILD, USER, ['2026-11-20']).size, 0);
    assert.equal(store.hasOpenVoice(GUILD, USER), false);
  });
});

describe('today is watched, not unknown', () => {
  const now = Date.UTC(2026, 10, 21, 20, 0, 0);

  it('shows today as quiet once the bot is running, not as untracked', () => {
    const days = recentDays(30, TZ, now);
    const today = days[days.length - 1]!;
    store.addCoverage(GUILD, today, 3600); // an hour in so far

    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.equal(summary.timeline[summary.timeline.length - 1], 'idle', 'we are watching today');
    assert.equal(summary.observedDays, 0, 'but today still is not a full day');
  });

  it('shows today as untracked when nothing has been recorded at all', () => {
    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.equal(summary.timeline[summary.timeline.length - 1], 'unknown');
  });
});

describe('activity shows up the same day', () => {
  const now = Date.UTC(2026, 10, 21, 20, 0, 0);

  it('counts voice, messages, active days and the score immediately', () => {
    const days = recentDays(30, TZ, now);
    const today = days[days.length - 1]!;
    store.addCoverage(GUILD, today, 3600);
    store.addVoiceSeconds(GUILD, USER, today, 20 * 60);

    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.equal(summary.voiceSeconds, 20 * 60, 'voice time is there at once');
    assert.equal(summary.activeDays, 1, 'today already counts as active');
    assert.ok(summary.score > 0, 'the score moves the same day');
    assert.equal(summary.daysSinceActive, 0, 'active today');
  });

  it('still reports no full days observed, which is a separate thing', () => {
    const days = recentDays(30, TZ, now);
    store.addCoverage(GUILD, days[days.length - 1]!, 3600);
    store.addVoiceSeconds(GUILD, USER, days[days.length - 1]!, 60 * 60);

    const summary = summarise(GUILD, USER, DEFAULT_SETTINGS, now);
    assert.ok(summary.score > 0, 'the score is live');
    assert.equal(summary.observedDays, 0, 'but no day has completed');
    assert.equal(summary.provisional, true, 'so The Purge still holds off');
  });
});

describe('the leaderboard only lists real, active people', () => {
  const now = Date.UTC(2026, 10, 21, 20, 0, 0);

  function fakeGuild(present: { id: string; name: string; bot?: boolean }[]) {
    const cache = new Map(
      present.map((entry) => [
        entry.id,
        { id: entry.id, displayName: entry.name, user: { bot: entry.bot ?? false } },
      ]),
    );
    return {
      id: GUILD,
      members: { cache, fetch: async () => cache },
    } as never;
  }

  it('leaves out members who are no longer in the server', async () => {
    const { buildBoard } = await import('../activity/ui.js');
    const days = recentDays(30, TZ, now);
    for (const day of days) store.addCoverage(GUILD, day, 86_400);
    for (const userId of ['here', 'gone']) {
      store.addVoiceSeconds(GUILD, userId, days[days.length - 2]!, 40 * 60);
    }

    const board = await buildBoard(fakeGuild([{ id: 'here', name: 'Here' }]));
    assert.deepEqual(
      board.map((entry) => entry.name),
      ['Here'],
      'someone who left is dropped, not shown as a ghost',
    );
  });

  it('leaves out people with nothing recorded', async () => {
    const { buildBoard } = await import('../activity/ui.js');
    const days = recentDays(30, TZ, now);
    for (const day of days) store.addCoverage(GUILD, day, 86_400);
    // Recorded, but every figure is zero.
    store.addVoiceSeconds(GUILD, 'idle', days[0]!, 0);
    store.countMessage(GUILD, 'busy', days[days.length - 2]!, now - 86_400_000, {
      dailyCap: 12,
      cooldownSeconds: 0,
    });

    const board = await buildBoard(
      fakeGuild([
        { id: 'idle', name: 'Idle' },
        { id: 'busy', name: 'Busy' },
      ]),
    );
    assert.ok(!board.some((entry) => entry.name === 'Idle'), 'a row of zeroes is not a ranking');
  });

  it('leaves bots off entirely', async () => {
    const { buildBoard } = await import('../activity/ui.js');
    const days = recentDays(30, TZ, now);
    for (const day of days) store.addCoverage(GUILD, day, 86_400);
    store.addVoiceSeconds(GUILD, 'botty', days[days.length - 2]!, 60 * 60);

    const board = await buildBoard(fakeGuild([{ id: 'botty', name: 'Botty', bot: true }]));
    assert.equal(board.length, 0);
  });
});
