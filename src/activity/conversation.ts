/**
 * Telling a debate apart from spam.
 *
 * A flat cooldown gets this backwards: a real back-and-forth is exactly when
 * people post quickly, and a spammer posting every 31 seconds sails through.
 * What actually separates them is whether anyone else is talking, and whether
 * the messages say anything new.
 *
 * Nothing here is persisted and no message text is stored — only short-lived
 * fingerprints held in memory, which are discarded as the window rolls.
 */

export interface MessageSignal {
  guildId: string;
  channelId: string;
  userId: string;
  at: number;
  /** Trimmed length. The text itself never leaves the caller. */
  length: number;
  /** Fingerprint of the normalised text, for near-duplicate detection. */
  fingerprint: number;
}

export interface ConversationRules {
  /** Minimum gap when nobody else is talking. */
  soloCooldownSeconds: number;
  /** Minimum gap when it is a genuine back-and-forth. */
  activeCooldownSeconds: number;
  /** Other voices needed since your last counted message to call it a conversation. */
  othersForConversation: number;
  /** Consecutive own messages before it reads as a monologue. */
  monologueRun: number;
}

export const DEFAULT_RULES: ConversationRules = {
  soloCooldownSeconds: 45,
  activeCooldownSeconds: 8,
  othersForConversation: 1,
  monologueRun: 5,
};

export type Reject = 'too-short' | 'too-soon' | 'duplicate' | 'monologue' | 'daily-cap';
export type Verdict = { counts: true } | { counts: false; reason: Reject };

/** Cheap, order-sensitive hash. Not reversible, and never written to disk. */
export function fingerprint(content: string): number {
  const normalised = content.toLowerCase().replace(/\s+/g, ' ').trim();
  let hash = 2166136261;
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= normalised.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT = 24;
/** Silence this long ends a run of solo messages. */
const RUN_RESET_MS = 15 * 60 * 1000;

interface ChannelState {
  /** Recent speakers, newest last. */
  recent: { userId: string; at: number }[];
}

interface UserState {
  lastCountedAt: number;
  /** Fingerprints of this member's last few messages here. */
  fingerprints: number[];
  /** How many messages in a row they have posted with nobody in between. */
  run: number;
}

const channels = new Map<string, ChannelState>();
const users = new Map<string, UserState>();

function channelKey(signal: MessageSignal): string {
  return `${signal.guildId}:${signal.channelId}`;
}

function userKey(signal: MessageSignal): string {
  return `${signal.guildId}:${signal.channelId}:${signal.userId}`;
}

/** Distinct other people who have spoken since `since`. */
function othersSince(state: ChannelState, userId: string, since: number): number {
  const seen = new Set<string>();
  for (const entry of state.recent) {
    if (entry.at <= since) continue;
    if (entry.userId === userId) continue;
    seen.add(entry.userId);
  }
  return seen.size;
}

/**
 * Decide whether a message counts. The caller still applies the daily cap.
 *
 * Counting rules, in plain terms:
 *  - too short to say anything → no
 *  - the same thing they just said → no
 *  - a long unbroken run with nobody replying → no
 *  - other people are talking → a short gap is fine, because that's a debate
 *  - talking to themselves → the long cooldown applies
 */
export function judge(
  signal: MessageSignal,
  minLength: number,
  rules: ConversationRules = DEFAULT_RULES,
): Verdict {
  const cKey = channelKey(signal);
  const uKey = userKey(signal);

  const channel = channels.get(cKey) ?? { recent: [] };
  const user = users.get(uKey) ?? { lastCountedAt: 0, fingerprints: [], run: 0 };

  // Roll the window forward before judging anything.
  channel.recent = channel.recent.filter((entry) => signal.at - entry.at < WINDOW_MS).slice(-MAX_RECENT);

  const lastSpeaker = channel.recent[channel.recent.length - 1];
  // A long gap starts a fresh run: posting in the morning should not silence
  // you all evening just because nobody replied.
  const continuing =
    lastSpeaker?.userId === signal.userId && signal.at - (lastSpeaker?.at ?? 0) < RUN_RESET_MS;

  // Only real messages build a run. Otherwise a few "lol"s would push someone
  // over the monologue line and block the thing they actually wanted to say.
  const substantive = signal.length >= minLength;
  const run = substantive ? (continuing ? user.run + 1 : 1) : user.run;

  const record = (counted: boolean) => {
    channel.recent.push({ userId: signal.userId, at: signal.at });
    channels.set(cKey, channel);
    users.set(uKey, {
      lastCountedAt: counted ? signal.at : user.lastCountedAt,
      // Only remember what a real message looked like, for duplicate checks.
      fingerprints: substantive
        ? [signal.fingerprint, ...user.fingerprints].slice(0, 6)
        : user.fingerprints,
      run,
    });
  };

  if (!substantive) {
    record(false);
    return { counts: false, reason: 'too-short' };
  }

  if (user.fingerprints.includes(signal.fingerprint)) {
    record(false);
    return { counts: false, reason: 'duplicate' };
  }

  const others = othersSince(channel, signal.userId, user.lastCountedAt);
  const conversational = others >= rules.othersForConversation;

  // A long solo run is a monologue however long the messages are.
  if (!conversational && run > rules.monologueRun) {
    record(false);
    return { counts: false, reason: 'monologue' };
  }

  const cooldownMs =
    (conversational ? rules.activeCooldownSeconds : rules.soloCooldownSeconds) * 1000;
  if (signal.at - user.lastCountedAt < cooldownMs) {
    record(false);
    return { counts: false, reason: 'too-soon' };
  }

  record(true);
  return { counts: true };
}

/** Drop state for a guild — used when tracking is turned off or data is wiped. */
export function forgetGuild(guildId: string): void {
  for (const key of [...channels.keys()]) if (key.startsWith(`${guildId}:`)) channels.delete(key);
  for (const key of [...users.keys()]) if (key.startsWith(`${guildId}:`)) users.delete(key);
}

/** Test seam. */
export function resetConversationState(): void {
  channels.clear();
  users.clear();
}
