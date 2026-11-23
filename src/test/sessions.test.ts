import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { openTestDatabase } from '../db/index.js';
import { clearSettingsCache } from '../db/settings.js';
import { clips, cooldowns, sessions, subs, weekly } from '../db/repos.js';
import { cancel, schedule } from '../scheduler.js';
import { getDb } from '../db/index.js';
import { rankCandidates, type Candidate } from '../features/clipOfWeek.js';
import { formatRoster } from '../ui/render.js';

const GUILD = 'g1';

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
});

function makeSession(startAt = Date.now() + 60_000) {
  return sessions.create({
    guildId: GUILD,
    channelId: 'c1',
    organizerId: 'ayub',
    game: 'Marvel Rivals',
    gameId: 'rivals',
    startAt,
  });
}

describe('sessions (acceptance test 8)', () => {
  it('puts the organizer in automatically', () => {
    const session = makeSession();
    assert.deepEqual(sessions.participants(session.id), ['ayub']);
  });

  it('toggles join and leave without duplicating anyone', () => {
    const session = makeSession();
    assert.equal(sessions.toggleParticipant(session.id, 'abdi'), 'joined');
    assert.equal(sessions.toggleParticipant(session.id, 'abdi'), 'left');
    assert.equal(sessions.toggleParticipant(session.id, 'abdi'), 'joined');
    assert.deepEqual(sessions.participants(session.id), ['ayub', 'abdi']);
  });

  it('survives a double click on the same button', () => {
    const session = makeSession();
    sessions.toggleParticipant(session.id, 'abdi');
    sessions.toggleParticipant(session.id, 'abdi');
    sessions.toggleParticipant(session.id, 'abdi');
    assert.equal(sessions.participants(session.id).length, 2);
  });

  it('only goes live once, however many times the job fires', () => {
    const session = makeSession();
    assert.equal(sessions.markLive(session.id), true);
    assert.equal(sessions.markLive(session.id), false, 'a duplicate start must be a no-op');
    assert.equal(sessions.byId(session.id)!.status, 'live');
  });

  it('sends each start notice exactly once (acceptance test 10)', () => {
    const session = makeSession();
    assert.equal(sessions.markNotice(session.id, 'ayub', 'start'), true);
    assert.equal(sessions.markNotice(session.id, 'ayub', 'start'), false, 'no duplicate DM after a restart');
    assert.equal(sessions.markNotice(session.id, 'ayub', 'alert'), true, 'a different notice kind is separate');
  });

  it('closes cleanly and stays closed', () => {
    const session = makeSession();
    assert.equal(sessions.close(session.id), true);
    assert.equal(sessions.close(session.id), false);
    assert.equal(sessions.byId(session.id)!.status, 'closed');
    assert.deepEqual(sessions.active(GUILD), []);
  });

  it('keeps the voice decision and its explanation', () => {
    const session = makeSession();
    sessions.setVoice(session.id, 'vc1', 'empty channel "General"');
    const stored = sessions.byId(session.id)!;
    assert.equal(stored.vc_channel_id, 'vc1');
    assert.match(stored.vc_reason!, /General/);
  });

  it('trims a long roster for the message', () => {
    assert.equal(formatRoster(['a', 'b']), 'a, b');
    assert.equal(formatRoster(['a', 'b', 'c', 'd', 'e', 'f']), 'a, b, c, d +2 more');
    assert.equal(formatRoster([]), 'nobody yet');
  });
});

describe('scheduler durability (acceptance tests 6 and 7)', () => {
  const countJobs = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n;

  it('never queues the same job twice', () => {
    for (let i = 0; i < 5; i += 1) {
      schedule({ guildId: GUILD, kind: 'session.start', ref: '1', runAt: Date.now() + 1000 });
    }
    assert.equal(countJobs(), 1);
  });

  it('reschedules in place rather than piling up', () => {
    const later = Date.now() + 90_000;
    schedule({ guildId: GUILD, kind: 'session.start', ref: '1', runAt: Date.now() });
    schedule({ guildId: GUILD, kind: 'session.start', ref: '1', runAt: later });
    const row = getDb().prepare(`SELECT run_at FROM jobs WHERE kind = ? AND ref = ?`).get('session.start', '1') as {
      run_at: number;
    };
    assert.equal(row.run_at, Math.round(later));
    assert.equal(countJobs(), 1);
  });

  it('keeps different refs and kinds apart, and cancels cleanly', () => {
    schedule({ guildId: GUILD, kind: 'session.start', ref: '1', runAt: Date.now() });
    schedule({ guildId: GUILD, kind: 'session.start', ref: '2', runAt: Date.now() });
    schedule({ guildId: GUILD, kind: 'session.close', ref: '1', runAt: Date.now() });
    assert.equal(countJobs(), 3);
    cancel('session.start', '1');
    assert.equal(countJobs(), 2);
  });
});

describe('clips, votes and the weekly winner', () => {
  it('records a clip once so it can never get two sets of reactions (acceptance test 1)', () => {
    const input = { messageId: 'm1', guildId: GUILD, channelId: 'c1', authorId: 'ayub', createdAt: Date.now() };
    assert.equal(clips.record(input), true);
    assert.equal(clips.record(input), false, 'a repeat must not react again');
  });

  it('leaves deleted clips out of the weekly window', () => {
    const now = Date.now();
    clips.record({ messageId: 'm1', guildId: GUILD, channelId: 'c1', authorId: 'a', createdAt: now - 1000 });
    clips.record({ messageId: 'm2', guildId: GUILD, channelId: 'c1', authorId: 'b', createdAt: now - 2000 });
    clips.markDeleted('m2');
    const found = clips.inWindow(GUILD, now - 86_400_000, now);
    assert.deepEqual(found.map((row) => row.message_id), ['m1']);
  });

  it('announces a week only once, even across a restart (acceptance test 6)', () => {
    assert.equal(weekly.claim(GUILD, '2026-W47', 'm1', 7), true);
    assert.equal(weekly.claim(GUILD, '2026-W47', 'm2', 9), false, 'second announcement blocked');
    assert.equal(weekly.wasAnnounced(GUILD, '2026-W47'), true);
    assert.equal(weekly.wasAnnounced(GUILD, '2026-W48'), false);
  });

  it('picks the highest score and breaks ties on the earliest post', () => {
    const candidate = (id: string, score: number, createdAt: number): Candidate =>
      ({ message: { id } as never, authorId: 'a', score, up: score, createdAt });

    assert.equal(rankCandidates([candidate('a', 3, 100), candidate('b', 7, 200)], 1)!.message.id, 'b');
    assert.equal(rankCandidates([candidate('a', 5, 300), candidate('b', 5, 100)], 1)!.message.id, 'b');
  });

  it('posts nothing when the minimum vote threshold is not met', () => {
    const candidate: Candidate = { message: { id: 'a' } as never, authorId: 'a', score: 1, up: 1, createdAt: 1 };
    assert.equal(rankCandidates([candidate], 3), null);
    assert.equal(rankCandidates([], 1), null);
  });
});

describe('notifications and warning limits (acceptance tests 5 and 11)', () => {
  it('subscribes to nothing by default', () => {
    assert.deepEqual(subs.list(GUILD, 'ayub'), []);
    assert.deepEqual(subs.subscribers(GUILD, 'GTA'), []);
  });

  it('replaces a member\'s subscriptions wholesale', () => {
    subs.set(GUILD, 'ayub', ['GTA', 'Valorant']);
    assert.deepEqual(subs.list(GUILD, 'ayub').sort(), ['GTA', 'Valorant']);
    subs.set(GUILD, 'ayub', ['GTA']);
    assert.deepEqual(subs.list(GUILD, 'ayub'), ['GTA']);
    assert.deepEqual(subs.subscribers(GUILD, 'Valorant'), []);
  });

  it('remembers a per-member mute', () => {
    assert.equal(subs.isMuted(GUILD, 'ayub'), false);
    subs.setMuted(GUILD, 'ayub', true);
    assert.equal(subs.isMuted(GUILD, 'ayub'), true);
    subs.setMuted(GUILD, 'ayub', false);
    assert.equal(subs.isMuted(GUILD, 'ayub'), false);
  });

  it('rate limits repeated warnings to the same member', () => {
    assert.equal(cooldowns.take(GUILD, 'ayub', 60_000), true);
    assert.equal(cooldowns.take(GUILD, 'ayub', 60_000), false, 'second warning suppressed');
    assert.equal(cooldowns.take(GUILD, 'abdi', 60_000), true, 'a different member is unaffected');
    assert.equal(cooldowns.take(GUILD, 'ayub', 0), true, 'a zero cooldown always allows');
  });
});
