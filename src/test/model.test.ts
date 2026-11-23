import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  activityScore,
  betaBinomialPmf,
  displayPercent,
  displayScore,
  inactivityProbability,
  logGamma,
  trend,
} from '../activity/model.js';

describe('Model A — activity score', () => {
  it('weights the four parts as specified', () => {
    // Only active days, at target: 35% of the score.
    const daysOnly = activityScore({
      activeDays: 12,
      scoredVoiceSeconds: 0,
      countedMessages: 0,
      daysSinceActive: null,
    });
    assert.equal(displayScore(daysOnly.score), 35);

    const voiceOnly = activityScore({
      activeDays: 0,
      scoredVoiceSeconds: 24 * 3600,
      countedMessages: 0,
      daysSinceActive: null,
    });
    assert.equal(displayScore(voiceOnly.score), 35);

    const messagesOnly = activityScore({
      activeDays: 0,
      scoredVoiceSeconds: 0,
      countedMessages: 100,
      daysSinceActive: null,
    });
    assert.equal(displayScore(messagesOnly.score), 20);

    const recencyOnly = activityScore({
      activeDays: 0,
      scoredVoiceSeconds: 0,
      countedMessages: 0,
      daysSinceActive: 0,
    });
    assert.equal(displayScore(recencyOnly.score), 10);
  });

  it('reaches 100 at target and 0 with nothing recorded', () => {
    const full = activityScore({
      activeDays: 12,
      scoredVoiceSeconds: 24 * 3600,
      countedMessages: 100,
      daysSinceActive: 0,
    });
    assert.equal(displayScore(full.score), 100);

    const none = activityScore({
      activeDays: 0,
      scoredVoiceSeconds: 0,
      countedMessages: 0,
      daysSinceActive: null,
    });
    assert.equal(none.score, 0);
  });

  it('caps each component rather than letting one run away', () => {
    const huge = activityScore({
      activeDays: 999,
      scoredVoiceSeconds: 999 * 3600,
      countedMessages: 99_999,
      daysSinceActive: 0,
    });
    assert.equal(displayScore(huge.score), 100);
    assert.equal(huge.days, 1);
    assert.equal(huge.voice, 1);
    assert.equal(huge.messages, 1);
  });

  it('halves recency every ten days', () => {
    const at0 = activityScore({ activeDays: 0, scoredVoiceSeconds: 0, countedMessages: 0, daysSinceActive: 0 });
    const at10 = activityScore({ activeDays: 0, scoredVoiceSeconds: 0, countedMessages: 0, daysSinceActive: 10 });
    const at20 = activityScore({ activeDays: 0, scoredVoiceSeconds: 0, countedMessages: 0, daysSinceActive: 20 });
    assert.ok(Math.abs(at10.recency - 0.5) < 1e-9);
    assert.ok(Math.abs(at20.recency - 0.25) < 1e-9);
    assert.equal(at0.recency, 1);
  });

  it('treats "never active" as zero recency, not a fresh start', () => {
    const never = activityScore({
      activeDays: 0,
      scoredVoiceSeconds: 0,
      countedMessages: 0,
      daysSinceActive: null,
    });
    assert.equal(never.recency, 0);
  });
});

describe('Model B — estimated inactivity', () => {
  it('matches the reference values for n = 30', () => {
    assert.equal(displayPercent(inactivityProbability({ activeDays: 0, observedDays: 30 })), 81);
    assert.ok(Math.abs(inactivityProbability({ activeDays: 0, observedDays: 30 }) - 0.8143) < 0.0005);
    assert.ok(Math.abs(inactivityProbability({ activeDays: 2, observedDays: 30 }) - 0.5672) < 0.0005);
    assert.ok(Math.abs(inactivityProbability({ activeDays: 10, observedDays: 30 }) - 0.0559) < 0.0005);
  });

  it('falls as observed activity rises', () => {
    let previous = 1;
    for (const s of [0, 1, 2, 5, 10, 20, 30]) {
      const current = inactivityProbability({ activeDays: s, observedDays: 30 });
      assert.ok(current < previous, `s=${s} should be lower than the step before`);
      previous = current;
    }
  });

  it('stays a probability for every input it could ever see', () => {
    for (const n of [0, 1, 7, 30, 500]) {
      for (const s of [0, 1, n, n + 10]) {
        const value = inactivityProbability({ activeDays: s, observedDays: n });
        assert.ok(value >= 0 && value <= 1, `n=${n} s=${s} gave ${value}`);
        assert.ok(Number.isFinite(value));
      }
    }
  });

  it('does not accuse anyone when nothing has been observed', () => {
    // With no evidence the Beta(2,5) prior expects a moderately active member,
    // so "probably inactive" stays low. Zero observation is not evidence of
    // absence, and the model must not behave as though it were.
    const blind = inactivityProbability({ activeDays: 0, observedDays: 0 });
    assert.ok(blind < 0.35, `no data should not look damning, got ${blind}`);

    // Quiet days only build the case once they have actually been observed.
    const week = inactivityProbability({ activeDays: 0, observedDays: 7 });
    const month = inactivityProbability({ activeDays: 0, observedDays: 30 });
    assert.ok(blind < week && week < month, 'confidence grows with observation');
  });

  it('has a pmf that sums to one', () => {
    let total = 0;
    for (let k = 0; k <= 14; k += 1) total += betaBinomialPmf(k, 14, 4, 33);
    assert.ok(Math.abs(total - 1) < 1e-9, `summed to ${total}`);
  });

  it('computes log-gamma accurately', () => {
    assert.ok(Math.abs(logGamma(1)) < 1e-9);
    assert.ok(Math.abs(logGamma(5) - Math.log(24)) < 1e-9);
    assert.ok(Math.abs(logGamma(10) - Math.log(362880)) < 1e-8);
  });
});

describe('Trends', () => {
  const full = { observedDays: 7 };

  it('needs coverage in both windows before saying anything', () => {
    assert.equal(trend({ messages: 50, voiceSeconds: 7200, observedDays: 2 }, { messages: 1, voiceSeconds: 0, ...full }).direction, 'none');
    assert.equal(trend({ messages: 50, voiceSeconds: 7200, ...full }, { messages: 1, voiceSeconds: 0, observedDays: 1 }).direction, 'none');
  });

  it('calls a real rise and a real fall', () => {
    const up = trend({ messages: 60, voiceSeconds: 7 * 3600, ...full }, { messages: 10, voiceSeconds: 3600, ...full });
    assert.equal(up.direction, 'up');

    const down = trend({ messages: 10, voiceSeconds: 3600, ...full }, { messages: 60, voiceSeconds: 7 * 3600, ...full });
    assert.equal(down.direction, 'down');
  });

  it('does not make a story out of a small wobble', () => {
    const steady = trend(
      { messages: 50, voiceSeconds: 7 * 3600, ...full },
      { messages: 52, voiceSeconds: 7.2 * 3600, ...full },
    );
    assert.equal(steady.direction, 'flat');
  });

  it('stays quiet when both windows are near-empty', () => {
    const quiet = trend({ messages: 1, voiceSeconds: 0, ...full }, { messages: 0, voiceSeconds: 0, ...full });
    assert.equal(quiet.direction, 'none');
    assert.equal(quiet.change, null);
  });
});
