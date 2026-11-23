/**
 * Two models, both deliberately simple and fully testable.
 *
 * Neither one is a judgement about a person. A low score means "we measured
 * little activity", which is not the same as "bad member", and the probability
 * is a model estimate, not a forecast anyone has validated.
 */

/* ------------------------------ Model A: score ----------------------------- */

export interface ScoreInput {
  /** Days in the window with qualifying activity. */
  activeDays: number;
  /** Voice seconds that counted, after the daily cap. */
  scoredVoiceSeconds: number;
  /** Messages that counted, after the daily cap. */
  countedMessages: number;
  /** Days since the last qualifying activity. Null when there has never been any. */
  daysSinceActive: number | null;
}

export interface ScoreBreakdown {
  score: number;
  /** The four normalised components, 0..1. */
  days: number;
  voice: number;
  messages: number;
  recency: number;
}

const TARGET_ACTIVE_DAYS = 12;
const TARGET_VOICE_HOURS = 24;
const TARGET_MESSAGES = 100;
const RECENCY_HALF_LIFE_DAYS = 10;

export function activityScore(input: ScoreInput): ScoreBreakdown {
  const days = clamp01(input.activeDays / TARGET_ACTIVE_DAYS);
  const voice = clamp01(input.scoredVoiceSeconds / 3600 / TARGET_VOICE_HOURS);
  const messages = clamp01(input.countedMessages / TARGET_MESSAGES);
  // Never seen active: recency contributes nothing rather than decaying from 1.
  const recency =
    input.daysSinceActive === null ? 0 : clamp01(Math.pow(2, -input.daysSinceActive / RECENCY_HALF_LIFE_DAYS));

  const raw = 100 * (0.35 * days + 0.35 * voice + 0.2 * messages + 0.1 * recency);
  return { score: clamp(raw, 0, 100), days, voice, messages, recency };
}

/** What gets shown. One rounding rule, used everywhere. */
export function displayScore(score: number): number {
  return Math.round(clamp(score, 0, 100));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/* --------------------- Model B: estimated inactivity ----------------------- */

/** Lanczos approximation. Accurate well past the precision we display. */
export function logGamma(x: number): number {
  const COEFFICIENTS = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000000000190015;
  for (const coefficient of COEFFICIENTS) {
    y += 1;
    series += coefficient / y;
  }
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}

export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** P(Y = k) for Y ~ BetaBinomial(trials, a, b). */
export function betaBinomialPmf(k: number, trials: number, a: number, b: number): number {
  if (k < 0 || k > trials) return 0;
  return Math.exp(logChoose(trials, k) + logBeta(a + k, b + trials - k) - logBeta(a, b));
}

export interface InactivityInput {
  /** Observed active days. */
  activeDays: number;
  /** Fully observed days, capped at 30. */
  observedDays: number;
  /** How far ahead to look. */
  horizonDays?: number;
}

export const PRIOR_ALPHA = 2;
export const PRIOR_BETA = 5;
const MAX_OBSERVED = 30;
const DEFAULT_HORIZON = 14;

/**
 * Probability of fewer than two active days over the next `horizonDays`,
 * under a Beta(2,5) prior updated with what we've observed.
 *
 * This is a model estimate from a deliberately weak prior. It has not been
 * calibrated against real outcomes, and it should never be the sole reason
 * anyone is removed.
 */
export function inactivityProbability(input: InactivityInput): number {
  const n = clamp(Math.floor(input.observedDays), 0, MAX_OBSERVED);
  const s = clamp(Math.floor(input.activeDays), 0, n);
  const horizon = input.horizonDays ?? DEFAULT_HORIZON;

  const a = PRIOR_ALPHA + s;
  const b = PRIOR_BETA + (n - s);

  const probability = betaBinomialPmf(0, horizon, a, b) + betaBinomialPmf(1, horizon, a, b);
  return clamp01(probability);
}

export function displayPercent(probability: number): number {
  return Math.round(clamp01(probability) * 100);
}

/* ------------------------------ Trends ------------------------------------- */

export type TrendDirection = 'up' | 'flat' | 'down' | 'none';

export interface TrendWindow {
  /** Counted messages in the window. */
  messages: number;
  /** Scored voice seconds in the window. */
  voiceSeconds: number;
  /** Fully observed days in the window. */
  observedDays: number;
}

export interface TrendResult {
  direction: TrendDirection;
  /** Relative change, -1..+∞. Null when there isn't enough coverage. */
  change: number | null;
}

const MIN_OBSERVED_PER_WINDOW = 5;
const FLAT_BAND = 0.25;
/** Below this there is too little activity for a ratio to mean anything. */
const MIN_SIGNAL = 0.5;

/**
 * Compares the last seven fully observed days with the seven before them.
 * Returns "no trend" rather than inventing a story from a tiny change.
 */
export function trend(recent: TrendWindow, previous: TrendWindow): TrendResult {
  if (recent.observedDays < MIN_OBSERVED_PER_WINDOW || previous.observedDays < MIN_OBSERVED_PER_WINDOW) {
    return { direction: 'none', change: null };
  }

  // One normalised measure per day observed, so uneven coverage is fair.
  const intensity = (window: TrendWindow): number =>
    (window.voiceSeconds / 3600 + window.messages / 10) / Math.max(1, window.observedDays);

  const now = intensity(recent);
  const before = intensity(previous);

  if (now < MIN_SIGNAL && before < MIN_SIGNAL) return { direction: 'none', change: null };

  if (before === 0) return { direction: now > 0 ? 'up' : 'flat', change: now > 0 ? 1 : 0 };

  const change = (now - before) / before;
  if (change > FLAT_BAND) return { direction: 'up', change };
  if (change < -FLAT_BAND) return { direction: 'down', change };
  return { direction: 'flat', change };
}
