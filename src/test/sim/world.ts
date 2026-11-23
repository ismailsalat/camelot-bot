/**
 * A small fake server: members, channels, messages and voice states shaped the
 * way discord.js presents them, so the tracking and review code can be driven
 * end to end without a gateway connection.
 *
 * It models the things that actually break in production — people joining and
 * leaving voice in any order, days rolling over in a timezone, the bot being
 * offline — rather than pretending everything is tidy.
 */

import { getSettings } from '../../db/settings.js';
import { dayKey, store, voiceChannelCounts } from '../../activity/store.js';
import { fingerprint, judge, resetConversationState } from '../../activity/conversation.js';
import { DEFAULT_RULES } from '../../activity/conversation.js';

export interface SimMember {
  id: string;
  name: string;
  bot: boolean;
  roleIds: string[];
  joinedAt: number;
}

export interface SimWorld {
  guildId: string;
  timezone: string;
  now: number;
  members: Map<string, SimMember>;
  /** userId -> channelId */
  voice: Map<string, string>;
  afkChannelId: string | null;
  /** channelId -> category id, for dynamically created voice channels. */
  parents: Map<string, string>;
  /** Whether the bot is up; coverage only accrues while it is. */
  online: boolean;
}

export function createWorld(options: Partial<SimWorld> = {}): SimWorld {
  return {
    guildId: 'G',
    timezone: 'America/Los_Angeles',
    now: Date.UTC(2026, 9, 1, 18, 0, 0),
    members: new Map(),
    voice: new Map(),
    afkChannelId: 'AFK',
    parents: new Map(),
    online: true,
    ...options,
  };
}

export function addMember(world: SimWorld, member: Partial<SimMember> & { id: string }): SimMember {
  const full: SimMember = {
    name: member.id,
    bot: false,
    roleIds: [],
    joinedAt: world.now - 200 * 86_400_000,
    ...member,
  };
  world.members.set(full.id, full);
  return full;
}

/** Move the clock forward, crediting coverage for the time the bot was up. */
export function advance(world: SimWorld, ms: number, stepMs = 5 * 60 * 1000): void {
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(stepMs, remaining);
    world.now += step;
    remaining -= step;
    if (world.online) {
      store.addCoverage(world.guildId, dayKey(world.now, world.timezone), Math.floor(step / 1000));
    }
  }
}

/** Post a message, applying the same rules the live tracker applies. */
export function say(
  world: SimWorld,
  userId: string,
  content: string,
  channelId = 'general',
): { counted: boolean; reason?: string } {
  const settings = getSettings(world.guildId);
  const member = world.members.get(userId);
  if (!member || member.bot) return { counted: false, reason: 'bot' };

  const verdict = judge(
    {
      guildId: world.guildId,
      channelId,
      userId,
      at: world.now,
      length: content.trim().length,
      fingerprint: fingerprint(content),
    },
    settings.activity.minMessageLength,
    {
      soloCooldownSeconds: settings.activity.messageCooldownSeconds,
      activeCooldownSeconds: settings.activity.activeCooldownSeconds,
      othersForConversation: DEFAULT_RULES.othersForConversation,
      monologueRun: DEFAULT_RULES.monologueRun,
    },
  );
  if (!verdict.counts) return { counted: false, reason: verdict.reason };

  const stored = store.countMessage(
    world.guildId,
    userId,
    dayKey(world.now, world.timezone),
    world.now,
    { dailyCap: settings.activity.dailyMessageCap, cooldownSeconds: 0 },
  );
  return stored ? { counted: true } : { counted: false, reason: 'daily-cap' };
}

/* ---------------------------------- voice ---------------------------------- */

function humansIn(world: SimWorld, channelId: string): string[] {
  return [...world.voice.entries()]
    .filter(([userId, channel]) => channel === channelId && !world.members.get(userId)?.bot)
    .map(([userId]) => userId);
}

function channelIsLive(world: SimWorld, channelId: string): boolean {
  const settings = getSettings(world.guildId);
  const ref = { id: channelId, parentId: world.parents.get(channelId) ?? null };
  if (!voiceChannelCounts(settings, ref, world.afkChannelId)) return false;
  return humansIn(world, channelId).length >= 2;
}

/** Mirrors tracker.reconcileChannel, including the midnight split. */
function reconcile(world: SimWorld, channelId: string | null): void {
  if (!channelId) return;
  const live = channelIsLive(world, channelId);
  for (const userId of humansIn(world, channelId)) {
    if (live && !store.hasOpenVoice(world.guildId, userId)) {
      store.openVoice(world.guildId, userId, channelId, world.now);
    } else if (!live) {
      closeAndCredit(world, userId);
    }
  }
}

function closeAndCredit(world: SimWorld, userId: string): void {
  const closed = store.closeVoice(world.guildId, userId);
  if (!closed) return;
  creditAcrossDays(world, userId, closed.startedAt, world.now);
}

function creditAcrossDays(world: SimWorld, userId: string, startedAt: number, endedAt: number): void {
  let cursor = startedAt;
  let guard = 0;
  while (cursor < endedAt && guard < 40) {
    guard += 1;
    const day = dayKey(cursor, world.timezone);
    let next = Math.min(endedAt, cursor + 86_400_000);
    if (dayKey(next, world.timezone) !== day) {
      let low = cursor;
      let high = next;
      while (high - low > 60_000) {
        const mid = Math.floor((low + high) / 2);
        if (dayKey(mid, world.timezone) === day) low = mid;
        else high = mid;
      }
      next = high;
    }
    store.addVoiceSeconds(world.guildId, userId, day, Math.floor((next - cursor) / 1000));
    cursor = next;
  }
}

export function joinVoice(world: SimWorld, userId: string, channelId: string): void {
  const previous = world.voice.get(userId);
  if (previous === channelId) return;
  if (previous) closeAndCredit(world, userId);
  world.voice.set(userId, channelId);
  reconcile(world, previous ?? null);
  reconcile(world, channelId);
}

export function leaveVoice(world: SimWorld, userId: string): void {
  const previous = world.voice.get(userId);
  if (!previous) return;
  closeAndCredit(world, userId);
  world.voice.delete(userId);
  reconcile(world, previous);
}

/** Simulate the process dying: open sessions are dropped, uncredited. */
export function crash(world: SimWorld): void {
  world.online = false;
  store.clearOpenVoice(world.guildId);
}

export function restart(world: SimWorld): void {
  world.online = true;
  resetConversationState();
  const channels = new Set(world.voice.values());
  for (const channelId of channels) reconcile(world, channelId);
}

/** Another bot drags somebody into a different channel, as join-to-create does. */
export function botMove(world: SimWorld, userId: string, channelId: string, parentId?: string): void {
  if (parentId) world.parents.set(channelId, parentId);
  joinVoice(world, userId, channelId);
}

/** A full day of coverage, for seeding history quickly. */
export function coverWholeDay(world: SimWorld, day: string): void {
  store.addCoverage(world.guildId, day, 86_400);
}
