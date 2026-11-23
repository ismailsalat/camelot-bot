import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_RULES,
  fingerprint,
  judge,
  resetConversationState,
  type MessageSignal,
} from '../activity/conversation.js';

beforeEach(() => resetConversationState());

let clock = Date.UTC(2026, 10, 21, 18, 0, 0);
const at = (seconds: number) => clock + seconds * 1000;

function msg(userId: string, content: string, seconds: number, channelId = 'c1'): MessageSignal {
  return {
    guildId: 'g',
    channelId,
    userId,
    at: at(seconds),
    length: content.trim().length,
    fingerprint: fingerprint(content),
  };
}

const counts = (signal: MessageSignal) => judge(signal, 2, DEFAULT_RULES).counts;
const why = (signal: MessageSignal) => {
  const verdict = judge(signal, 2, DEFAULT_RULES);
  return verdict.counts ? 'counted' : verdict.reason;
};

describe('fingerprints', () => {
  it('treats the same thing said differently as the same', () => {
    assert.equal(fingerprint('Hello   There'), fingerprint('hello there'));
    assert.notEqual(fingerprint('hello there'), fingerprint('hello friend'));
  });

  it('is a number, so nothing readable is ever kept', () => {
    assert.equal(typeof fingerprint('a secret message'), 'number');
  });
});

describe('spam versus debate', () => {
  it('lets people argue quickly', () => {
    assert.equal(counts(msg('a', 'that trade made no sense at all', 0)), true);
    assert.equal(counts(msg('b', 'it made perfect sense actually', 5)), true);
    assert.equal(counts(msg('a', 'explain how it did then', 10)), true);
    assert.equal(counts(msg('b', 'they needed a backup guard badly', 14)), true);
  });

  it('makes a lone poster wait', () => {
    assert.equal(counts(msg('a', 'first thought about the game', 0)), true);
    assert.equal(why(msg('a', 'second thought about the game', 10)), 'too-soon');
    assert.equal(counts(msg('a', 'third thought about the game', 60)), true);
  });

  it('refuses a repeated message', () => {
    assert.equal(counts(msg('a', 'same thing twice', 0)), true);
    assert.equal(why(msg('a', 'same thing twice', 120)), 'duplicate');
  });

  it('cuts off a long monologue even with real sentences', () => {
    let blocked = false;
    for (let i = 0; i < 10; i += 1) {
      const verdict = why(msg('a', `a distinct thought number ${i} here`, i * 60));
      if (verdict === 'monologue') blocked = true;
    }
    assert.ok(blocked, 'talking to yourself forever should stop counting');
  });

  it('forgives the monologue once somebody replies', () => {
    for (let i = 0; i < 8; i += 1) judge(msg('a', `solo thought ${i} padded`, i * 60), 2, DEFAULT_RULES);
    assert.equal(counts(msg('b', 'actually I disagree with that', 500)), true);
    assert.equal(counts(msg('a', 'fair point but consider this', 510)), true);
  });

  it('ignores one-word filler', () => {
    assert.equal(why(msg('a', 'k', 0)), 'too-short');
    assert.equal(why(msg('a', '', 10)), 'too-short');
  });

  it('keeps channels separate', () => {
    assert.equal(counts(msg('a', 'a message in one place', 0, 'c1')), true);
    assert.equal(counts(msg('a', 'a message in another place', 1, 'c2')), true);
  });

  it('does not let a second person be used as cover for a flood', () => {
    // b speaks once; a then floods. The conversation window only excuses a
    // short gap, not an unlimited run.
    judge(msg('b', 'one comment from someone else', 0), 2, DEFAULT_RULES);
    let counted = 0;
    for (let i = 0; i < 12; i += 1) {
      if (counts(msg('a', `flood message number ${i} padded out`, 5 + i))) counted += 1;
    }
    assert.ok(counted <= 2, `one reply should not unlock a flood, counted ${counted}`);
  });
});

describe('a gap ends a run of solo messages', () => {
  it('lets someone post again in the evening after a quiet morning run', () => {
    // Six messages alone: the last ones get cut off as a monologue.
    for (let i = 0; i < 7; i += 1) judge(msg('a', `morning thought ${i} padded out`, i * 60), 2, DEFAULT_RULES);
    assert.equal(why(msg('a', 'one more right after', 7 * 60)), 'monologue');

    // Hours later it should be a fresh start, not a permanent silencing.
    assert.equal(counts(msg('a', 'evening thought, totally new', 7 * 60 + 3600)), true);
  });
});

describe('filler does not silence a real message', () => {
  it('ignores short filler when working out a monologue', () => {
    // A handful of "lol"s should cost nothing.
    for (let i = 0; i < 8; i += 1) judge(msg('a', 'k', i * 10), 2, DEFAULT_RULES);
    assert.equal(counts(msg('a', 'here is an actual point about the game', 600)), true);
  });

  it('still stops a run of real solo messages', () => {
    let blocked = false;
    for (let i = 0; i < 9; i += 1) {
      if (why(msg('a', `a real and distinct sentence ${i}`, i * 60)) === 'monologue') blocked = true;
    }
    assert.ok(blocked);
  });

  it('does not let one-character filler block the next real message', () => {
    // The threshold is two characters, so a single letter is filler.
    assert.equal(why(msg('a', 'k', 0)), 'too-short');
    assert.equal(counts(msg('b', 'something substantial here', 5)), true);
    assert.equal(counts(msg('a', 'a genuine reply to that point', 15)), true);
  });
});
