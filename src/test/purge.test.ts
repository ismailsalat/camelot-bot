import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { openTestDatabase } from '../db/index.js';
import { DEFAULT_SETTINGS, clearSettingsCache, type GuildSettings } from '../db/settings.js';
import {
  exemptions,
  isProtected,
  protectionFor,
  selectCandidates,
  type CandidateInput,
  type MemberFacts,
} from '../purge/policy.js';
import { purgeLog, reviews } from '../purge/session.js';
import type { MemberSummary } from '../activity/summary.js';

const GUILD = 'g1';
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
});

const withPurge = (patch: Partial<GuildSettings['purge']>): GuildSettings => ({
  ...DEFAULT_SETTINGS,
  purge: { ...DEFAULT_SETTINGS.purge, ...patch },
});

function facts(overrides: Partial<MemberFacts> = {}): MemberFacts {
  return {
    userId: 'u1',
    isOwner: false,
    isBot: false,
    roleIds: [],
    joinedAt: NOW - 365 * 86_400_000,
    ...overrides,
  };
}

function summary(overrides: Partial<MemberSummary> = {}): MemberSummary {
  return {
    userId: 'u1',
    voiceSeconds: 0,
    scoredVoiceSeconds: 0,
    messages: 0,
    activeDays: 0,
    observedDays: 30,
    lastActiveDay: null,
    daysSinceActive: 40,
    score: 5,
    inactivityPercent: 80,
    trend: { direction: 'none', change: null },
    timeline: [],
    provisional: false,
    ...overrides,
  };
}

describe('protection', () => {
  it('always protects the server owner', () => {
    const result = protectionFor(facts({ isOwner: true }), DEFAULT_SETTINGS, null, NOW);
    assert.equal(result.kind, 'owner');
    assert.equal(isProtected(result), true);
  });

  it('leaves identity roles unprotected unless configured', () => {
    // Knights and Ladies are identity roles, not protection.
    const settings = withPurge({ absoluteRoles: ['ROUND_TABLE'] });
    const knight = protectionFor(facts({ roleIds: ['KNIGHTS'] }), settings, null, NOW);
    assert.equal(knight.kind, 'none');

    const lady = protectionFor(facts({ roleIds: ['LADIES'] }), settings, null, NOW);
    assert.equal(lady.kind, 'none');

    const roundTable = protectionFor(facts({ roleIds: ['ROUND_TABLE'] }), settings, null, NOW);
    assert.equal(roundTable.kind, 'absolute');
  });

  it('lets absolute protection beat any other policy', () => {
    const settings = withPurge({
      absoluteRoles: ['DONT_KICK'],
      rolePolicies: [{ roleId: 'KNIGHTS', effect: 'normal' }],
    });
    const result = protectionFor(facts({ roleIds: ['KNIGHTS', 'DONT_KICK'] }), settings, null, NOW);
    assert.equal(result.kind, 'absolute');
  });

  it('does not stack policies — the first match decides', () => {
    const settings = withPurge({
      rolePolicies: [
        { roleId: 'A', effect: 'normal' },
        { roleId: 'B', effect: 'protect' },
      ],
    });
    // A comes first in priority order, so B never applies.
    const result = protectionFor(facts({ roleIds: ['A', 'B'] }), settings, null, NOW);
    assert.equal(result.kind, 'none');

    // Without A, B protects.
    const onlyB = protectionFor(facts({ roleIds: ['B'] }), settings, null, NOW);
    assert.equal(onlyB.kind, 'role');
  });

  it('honours a live exemption and ignores an expired one', () => {
    const live = protectionFor(facts(), DEFAULT_SETTINGS, { until: NOW + 86_400_000, note: null }, NOW);
    assert.equal(live.kind, 'exempt');

    const expired = protectionFor(facts(), DEFAULT_SETTINGS, { until: NOW - 1000, note: null }, NOW);
    assert.equal(expired.kind, 'none');
  });
});

describe('exemption storage', () => {
  it('stores, expires and clears', () => {
    exemptions.set(GUILD, 'u1', NOW + 86_400_000, 'exams', 'owner');
    assert.equal(exemptions.get(GUILD, 'u1', NOW)?.note, 'exams');

    assert.equal(exemptions.get(GUILD, 'u1', NOW + 2 * 86_400_000), null, 'expired stops applying');

    exemptions.clear(GUILD, 'u1');
    assert.equal(exemptions.get(GUILD, 'u1', NOW), null);
  });

  it('prunes expired rows without touching live ones', () => {
    exemptions.set(GUILD, 'old', NOW - 1000, null, 'owner');
    exemptions.set(GUILD, 'live', NOW + 86_400_000, null, 'owner');
    assert.equal(exemptions.pruneExpired(NOW), 1);
    assert.equal(exemptions.get(GUILD, 'live', NOW)?.userId, 'live');
  });
});

describe('candidate selection', () => {
  const settings = DEFAULT_SETTINGS;

  const input = (overrides: { facts?: Partial<MemberFacts>; summary?: Partial<MemberSummary> } = {}): CandidateInput => {
    const f = facts({ userId: overrides.facts?.userId ?? 'u1', ...overrides.facts });
    return {
      facts: f,
      summary: summary({ userId: f.userId, ...overrides.summary }),
      protection: protectionFor(f, settings, exemptions.get(GUILD, f.userId, NOW), NOW),
    };
  };

  it('picks up someone quiet for long enough', () => {
    const chosen = selectCandidates([input()], 'inactive', settings, NOW);
    assert.equal(chosen.length, 1);
    assert.match(chosen[0]!.reason!, /Quiet for 40 days/);
  });

  it('leaves a recently active member alone', () => {
    const chosen = selectCandidates([input({ summary: { daysSinceActive: 3 } })], 'inactive', settings, NOW);
    assert.equal(chosen.length, 0);
  });

  it('respects the newcomer grace period', () => {
    const fresh = input({ facts: { joinedAt: NOW - 5 * 86_400_000 } });
    assert.equal(selectCandidates([fresh], 'inactive', settings, NOW).length, 0);
  });

  it('will not judge anyone before tracking has run long enough', () => {
    const thin = input({ summary: { observedDays: 3 } });
    assert.equal(
      selectCandidates([thin], 'inactive', settings, NOW).length,
      0,
      'a short tracking history is not evidence about a person',
    );
  });

  it('keeps protected members out of the inactive list but shows them under "all"', () => {
    const settingsWithRole = withPurge({ absoluteRoles: ['SAFE'] });
    const f = facts({ roleIds: ['SAFE'] });
    const protectedInput: CandidateInput = {
      facts: f,
      summary: summary(),
      protection: protectionFor(f, settingsWithRole, null, NOW),
    };

    assert.equal(selectCandidates([protectedInput], 'inactive', settingsWithRole, NOW).length, 0);

    const all = selectCandidates([protectedInput], 'all', settingsWithRole, NOW);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.reviewable, false, 'visible, but the Purge button is disabled');
  });

  it('ignores bots entirely', () => {
    assert.equal(selectCandidates([input({ facts: { isBot: true } })], 'all', settings, NOW).length, 0);
  });

  it('sorts the quietest first, with never-active ahead of the rest', () => {
    const chosen = selectCandidates(
      [
        input({ facts: { userId: 'recent' }, summary: { daysSinceActive: 25 } }),
        input({ facts: { userId: 'never' }, summary: { daysSinceActive: null } }),
        input({ facts: { userId: 'oldest' }, summary: { daysSinceActive: 60 } }),
      ],
      'inactive',
      settings,
      NOW,
    );
    assert.deepEqual(
      chosen.map((candidate) => candidate.facts.userId),
      ['never', 'oldest', 'recent'],
    );
  });
});

describe('review sessions', () => {
  it('records decisions, tallies them, and keeps review order', () => {
    const session = reviews.start(GUILD, 'admin', 'inactive', ['a', 'b', 'c', 'd']);
    reviews.decide(session.id, 'a', 'keep');
    reviews.decide(session.id, 'b', 'purge');
    reviews.decide(session.id, 'd', 'purge');

    const tally = reviews.tally(session.id);
    assert.equal(tally.keep, 1);
    assert.equal(tally.purge, 2);
    assert.equal(tally.skipped, 1, 'c was never decided');
    assert.deepEqual(reviews.queued(session.id), ['b', 'd']);
  });

  it('lets a decision be changed', () => {
    const session = reviews.start(GUILD, 'admin', 'inactive', ['a']);
    reviews.decide(session.id, 'a', 'purge');
    reviews.decide(session.id, 'a', 'keep');
    assert.deepEqual(reviews.queued(session.id), []);
    assert.equal(reviews.tally(session.id).keep, 1);
  });

  it('survives a restart and resumes where it was', () => {
    const session = reviews.start(GUILD, 'admin', 'inactive', ['a', 'b']);
    reviews.setCursor(session.id, 1);
    reviews.decide(session.id, 'a', 'purge');

    const resumed = reviews.findFor(GUILD, 'admin');
    assert.equal(resumed?.id, session.id);
    assert.equal(resumed?.cursor, 1);
    assert.deepEqual(reviews.queued(session.id), ['a']);
  });

  it('keeps one session per admin and does not mix two admins', () => {
    const first = reviews.start(GUILD, 'admin', 'inactive', ['a']);
    const second = reviews.start(GUILD, 'admin', 'eligible', ['b']);
    assert.notEqual(first.id, second.id);
    assert.equal(reviews.get(first.id), null, 'starting again replaces the old one');

    const other = reviews.start(GUILD, 'admin2', 'inactive', ['c']);
    assert.equal(reviews.findFor(GUILD, 'admin2')?.id, other.id);
    assert.equal(reviews.findFor(GUILD, 'admin')?.id, second.id);
  });

  it('cleans up abandoned sessions', () => {
    const session = reviews.start(GUILD, 'admin', 'inactive', ['a']);
    reviews.decide(session.id, 'a', 'purge');
    assert.equal(reviews.pruneStale(Date.now() + 48 * 60 * 60 * 1000), 1);
    assert.equal(reviews.get(session.id), null);
    assert.equal(reviews.decisions(session.id).size, 0, 'decisions go with it');
  });

  it('clears everything when a review finishes', () => {
    const session = reviews.start(GUILD, 'admin', 'inactive', ['a']);
    reviews.decide(session.id, 'a', 'purge');
    reviews.finish(session.id);
    assert.equal(reviews.get(session.id), null);
    assert.equal(reviews.findFor(GUILD, 'admin'), null);
  });
});

describe('removal log', () => {
  it('records successes and failures separately', () => {
    purgeLog.record({ guildId: GUILD, actorId: 'admin', userId: 'a', reason: 'review', success: true });
    purgeLog.record({
      guildId: GUILD,
      actorId: 'admin',
      userId: 'b',
      reason: 'review',
      success: false,
      detail: 'Missing Permissions',
    });

    const recent = purgeLog.recent(GUILD);
    assert.equal(recent.length, 2);
    assert.equal(recent.filter((entry) => entry.success).length, 1);
    assert.equal(recent.find((entry) => !entry.success)?.detail, 'Missing Permissions');
  });

  it('prunes old entries', () => {
    purgeLog.record({ guildId: GUILD, actorId: 'admin', userId: 'a', reason: 'review', success: true });
    purgeLog.prune(GUILD, 0, Date.now() + 86_400_000);
    assert.equal(purgeLog.recent(GUILD).length, 0);
  });
});
