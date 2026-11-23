import { ChannelType, type Client, type Guild, type Message, type VoiceState } from 'discord.js';
import { getSettings } from '../db/settings.js';
import { isModuleEnabled } from '../core/registry.js';
import { log } from '../logger.js';
import { dayKey, store, textChannelCounts, voiceChannelCounts, type ChannelRef } from './store.js';
import { DEFAULT_RULES, fingerprint, judge } from './conversation.js';

/**
 * Event-driven tracking. No polling of Discord, no message history scans, and
 * no message text or audio ever stored — only counters.
 */

/** Resolved once per guild: the channel literally named "general". */
const generalCache = new Map<string, string | null>();

function generalChannelId(guild: Guild): string | null {
  const cached = generalCache.get(guild.id);
  if (cached !== undefined) return cached;
  const found =
    guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name.toLowerCase() === 'general',
    )?.id ?? null;
  generalCache.set(guild.id, found);
  return found;
}

export function forgetGeneralChannel(guildId: string): void {
  generalCache.delete(guildId);
}

/* -------------------------------- messages --------------------------------- */

/** A thread's messages belong to the channel it hangs off. */
function messageChannelRef(message: Message<true>): ChannelRef {
  const channel = message.channel;
  if (channel.isThread()) return { id: channel.id, parentId: channel.parentId };
  return { id: channel.id, parentId: channel.parentId ?? null };
}

export function trackMessage(message: Message): void {
  if (!message.inGuild()) return;
  // Bots, webhooks and Discord's own join notices are not activity.
  if (message.author.bot || message.webhookId || message.system) return;

  const settings = getSettings(message.guildId);
  if (!isModuleEnabled(settings, 'activity') || !settings.activity.enabled) return;
  if (!textChannelCounts(settings, messageChannelRef(message), generalChannelId(message.guild))) return;

  const content = message.content ?? '';
  const now = message.createdTimestamp;

  // Posting a clip or a photo is taking part, even with nothing typed.
  const hasMedia = message.attachments.size > 0 || message.stickers.size > 0;
  const effectiveLength = hasMedia ? Math.max(content.trim().length, settings.activity.minMessageLength) : content.trim().length;

  // The text is read here and nowhere else: only its length and a one-way
  // fingerprint leave this function, and neither is written to the database.
  const verdict = judge(
    {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      at: now,
      length: effectiveLength,
      // An attachment makes an otherwise identical message its own thing.
      fingerprint: fingerprint(hasMedia ? `${content}#${message.id}` : content),
    },
    settings.activity.minMessageLength,
    {
      soloCooldownSeconds: settings.activity.messageCooldownSeconds,
      activeCooldownSeconds: settings.activity.activeCooldownSeconds,
      othersForConversation: DEFAULT_RULES.othersForConversation,
      monologueRun: DEFAULT_RULES.monologueRun,
    },
  );
  if (!verdict.counts) return;

  store.countMessage(message.guildId, message.author.id, dayKey(now, settings.timezone), now, {
    dailyCap: settings.activity.dailyMessageCap,
    // The conversation rules already applied the gap; the store only enforces
    // the daily cap from here.
    cooldownSeconds: 0,
  });
}

/* ---------------------------------- voice ---------------------------------- */

/**
 * Non-bot members currently sitting in a voice channel.
 *
 * Deliberately keyed off the voice state's own user id rather than its cached
 * member: an uncached member used to drop out of the head-count silently, so a
 * two-person channel looked like one and the clock never started. A user we
 * cannot resolve is treated as a person — undercounting people is the failure
 * that loses real time.
 */
function humansIn(guild: Guild, channelId: string): string[] {
  const ids: string[] = [];
  for (const state of guild.voiceStates.cache.values()) {
    if (state.channelId !== channelId) continue;
    const userId = state.id;
    if (!userId) continue;
    const isBot = state.member?.user.bot ?? guild.client.users.cache.get(userId)?.bot ?? false;
    if (isBot) continue;
    ids.push(userId);
  }
  return ids;
}

/**
 * Time only counts when at least two real people share an eligible channel.
 * Being connected alone, or with bots, is not activity.
 */
/** Voice channels carry their category, which is how temporary ones match. */
function voiceRef(guild: Guild, channelId: string): ChannelRef {
  return { id: channelId, parentId: guild.channels.cache.get(channelId)?.parentId ?? null };
}

function channelIsLive(guild: Guild, channelId: string): boolean {
  const settings = getSettings(guild.id);
  if (!voiceChannelCounts(settings, voiceRef(guild, channelId), guild.afkChannelId)) return false;
  return humansIn(guild, channelId).length >= 2;
}

/**
 * Bring every open session in a channel in line with reality. Called whenever
 * anyone moves, so the second person arriving starts the clock for both and
 * the second-to-last leaving stops it for everyone.
 */
export function reconcileChannel(guild: Guild, channelId: string | null, at = Date.now()): void {
  if (!channelId) return;
  const settings = getSettings(guild.id);
  if (!isModuleEnabled(settings, 'activity') || !settings.activity.enabled) return;

  const live = channelIsLive(guild, channelId);
  const present = new Set(humansIn(guild, channelId));

  for (const userId of present) {
    if (live && !store.hasOpenVoice(guild.id, userId)) {
      store.openVoice(guild.id, userId, channelId, at);
    } else if (!live) {
      creditAndClose(guild, userId, at);
    }
  }
}

function creditAndClose(guild: Guild, userId: string, at: number): void {
  const closed = store.closeVoice(guild.id, userId);
  if (!closed) return;

  const settings = getSettings(guild.id);
  const seconds = Math.max(0, Math.floor((at - closed.startedAt) / 1000));
  if (seconds <= 0) return;

  // A session spanning midnight is split so each day gets its own credit.
  creditAcrossDays(guild.id, userId, closed.startedAt, at, settings.timezone);
}

function creditAcrossDays(
  guildId: string,
  userId: string,
  startedAt: number,
  endedAt: number,
  timeZone: string,
): void {
  let cursor = startedAt;
  let guard = 0;
  while (cursor < endedAt && guard < 40) {
    guard += 1;
    const day = dayKey(cursor, timeZone);
    // Walk forward to the first instant that lands on a different day.
    let next = Math.min(endedAt, cursor + 86_400_000);
    if (dayKey(next, timeZone) !== day) {
      let low = cursor;
      let high = next;
      while (high - low > 60_000) {
        const mid = Math.floor((low + high) / 2);
        if (dayKey(mid, timeZone) === day) low = mid;
        else high = mid;
      }
      next = high;
    }
    store.addVoiceSeconds(guildId, userId, day, Math.floor((next - cursor) / 1000));
    cursor = next;
  }
}

export function trackVoiceState(oldState: VoiceState, newState: VoiceState): void {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;
  const userId = newState.id ?? oldState.id;

  const settings = getSettings(guild.id);
  if (!isModuleEnabled(settings, 'activity') || !settings.activity.enabled) return;

  const at = Date.now();
  const left = oldState.channelId;
  const joined = newState.channelId;
  if (left === joined) return; // mute/deafen/stream — not a move

  // The person who moved stops earning in the old channel immediately.
  if (left && userId) creditAndClose(guild, userId, at);

  // Both channels may have crossed the two-person line in either direction.
  reconcileChannel(guild, left, at);
  reconcileChannel(guild, joined, at);
}

/**
 * A safety net for missed or dropped gateway events: walk every voice channel
 * that has anyone in it and make the open sessions match reality. Also closes
 * sessions for people who are no longer in voice at all.
 */
export function sweepVoice(client: Client, at = Date.now()): void {
  for (const guild of client.guilds.cache.values()) {
    const settings = getSettings(guild.id);
    if (!isModuleEnabled(settings, 'activity') || !settings.activity.enabled) continue;

    const connected = new Set<string>();
    const channelIds = new Set<string>();
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || !state.id) continue;
      connected.add(state.id);
      channelIds.add(state.channelId);
    }

    // Anyone with an open session who has quietly left gets banked and closed.
    for (const userId of store.openVoiceUsers(guild.id)) {
      if (!connected.has(userId)) creditAndClose(guild, userId, at);
    }

    for (const channelId of channelIds) reconcileChannel(guild, channelId, at);
  }
}

/**
 * At boot, open sessions from the previous run are dropped without credit:
 * we cannot know how long the bot was actually down, and inventing hours is
 * worse than losing a few real minutes. Then we start fresh from what is
 * actually happening right now.
 */
export function reconcileOnReady(client: Client): void {
  const dropped = store.clearOpenVoice();
  if (dropped > 0) log.info(`Dropped ${dropped} stale voice session(s) from the last run.`);

  for (const guild of client.guilds.cache.values()) {
    const settings = getSettings(guild.id);
    if (!isModuleEnabled(settings, 'activity') || !settings.activity.enabled) continue;

    const channelIds = new Set(
      [...guild.voiceStates.cache.values()].map((state) => state.channelId).filter((id): id is string => !!id),
    );
    for (const channelId of channelIds) reconcileChannel(guild, channelId);
  }
}

/**
 * Close every open session and bank the time. Used on shutdown so a clean
 * restart doesn't throw away what people were doing.
 */
export function flushOpenSessions(client: Client, at = Date.now()): void {
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (state.member && !state.member.user.bot) creditAndClose(guild, state.member.id, at);
    }
  }
}
