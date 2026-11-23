import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type Message,
  type VoiceChannel,
} from 'discord.js';
import { sessions, type SessionRow } from '../db/repos.js';
import { gameById, getSettings, sessionsChannelId, type GuildSettings } from '../db/settings.js';
import { resolveEmoji } from '../util/emoji.js';
import { registerJob, schedule, cancel } from '../scheduler.js';
import { renderSession, renderStartNotice } from '../ui/render.js';
import { pickVoiceChannel } from './vcPicker.js';
import { botCan, channelLink, fetchTextChannel, soft } from '../util/discord.js';
import { NO_MENTIONS } from '../util/mentions.js';
import { log } from '../logger.js';

export const JOB_START = 'session.start';
export const JOB_CLOSE = 'session.close';

/** Per-session edit queue, so two fast clicks can't race on the same message. */
const queues = new Map<number, Promise<unknown>>();
function enqueue<T>(sessionId: number, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    sessionId,
    next.catch(() => undefined),
  );
  return next;
}

function gameEmojiFor(settings: GuildSettings, gameId: string | null, client: Client): string | null {
  if (!gameId) return null;
  const game = gameById(settings, gameId);
  return game ? resolveEmoji(game.emoji, '🎮', client) : null;
}

/* ------------------------------- creation --------------------------------- */

export async function createSession(input: {
  guild: Guild;
  organizerId: string;
  game: string;
  gameId: string;
  startAt: number;
}): Promise<{ session: SessionRow; message: Message | null; channelName: string | null }> {
  const settings = getSettings(input.guild.id);
  const channelId = sessionsChannelId(settings);
  const channel = await fetchTextChannel(input.guild, channelId);
  if (!channel) throw new Error('No session channel is configured. An admin can set one with /camelot setup.');
  if (!botCan(channel, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages)) {
    throw new Error(`I can't post in #${channel.name}.`);
  }

  const session = sessions.create({
    guildId: input.guild.id,
    channelId: channel.id,
    organizerId: input.organizerId,
    game: input.game,
    gameId: input.gameId,
    startAt: input.startAt,
  });

  const names = await displayNames(input.guild, sessions.participants(session.id));
  const gameEmoji = gameEmojiFor(settings, session.game_id, input.guild.client);
  const posted = await soft('post session', () =>
    channel.send({
      ...renderSession({ session, names, settings, client: input.guild.client, gameEmoji }),
      allowedMentions: NO_MENTIONS,
    }),
  );

  if (posted) sessions.setMessageId(session.id, posted.id);

  scheduleSessionJobs(session, settings, input.startAt);

  return { session: sessions.byId(session.id)!, message: posted, channelName: channel.name };
}

export function scheduleSessionJobs(session: SessionRow, settings: GuildSettings, startAt: number): void {
  schedule({
    guildId: session.guild_id,
    kind: JOB_START,
    ref: String(session.id),
    runAt: Math.max(startAt, Date.now() + 500),
  });
  schedule({
    guildId: session.guild_id,
    kind: JOB_CLOSE,
    ref: String(session.id),
    runAt: startAt + settings.games.durationMinutes * 60_000,
  });
}

/* --------------------------------- names ---------------------------------- */

export async function displayNames(guild: Guild, userIds: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const id of userIds) {
    const cached = guild.members.cache.get(id);
    if (cached) {
      names.push(cached.displayName);
      continue;
    }
    const fetched = await soft(`fetch member ${id}`, () => guild.members.fetch(id));
    names.push(fetched?.displayName ?? 'someone');
  }
  return names;
}

/* ------------------------------ message refresh ---------------------------- */

export async function refreshSessionMessage(client: Client, sessionId: number): Promise<void> {
  await enqueue(sessionId, async () => {
    const session = sessions.byId(sessionId);
    if (!session?.message_id) return;

    const guild = await soft('fetch guild', () => client.guilds.fetch(session.guild_id));
    if (!guild) return;

    const channel = await fetchTextChannel(guild, session.channel_id);
    if (!channel) return;

    const message = await soft('fetch session message', () => channel.messages.fetch(session.message_id!));
    if (!message) return;

    const settings = getSettings(guild.id);
    const names = await displayNames(guild, sessions.participants(sessionId));
    const voiceChannelName = session.vc_channel_id
      ? (guild.channels.cache.get(session.vc_channel_id)?.name ?? null)
      : null;

    await soft('edit session message', () =>
      message.edit({
        ...renderSession({
          session,
          names,
          settings,
          voiceChannelName,
          client,
          gameEmoji: gameEmojiFor(settings, session.game_id, client),
        }),
        allowedMentions: NO_MENTIONS,
      }),
    );
  });
}

/* -------------------------------- joining ---------------------------------- */

export interface JoinOutcome {
  state: 'joined' | 'left';
  session: SessionRow;
  /** Set when the session is already live and a VC is known. */
  voiceLink: string | null;
  voiceName: string | null;
}

export async function toggleJoin(client: Client, sessionId: number, userId: string): Promise<JoinOutcome | null> {
  const session = sessions.byId(sessionId);
  if (!session || session.status === 'closed' || session.status === 'cancelled') return null;

  const state = sessions.toggleParticipant(sessionId, userId);
  await refreshSessionMessage(client, sessionId);

  const fresh = sessions.byId(sessionId)!;
  let voiceLink: string | null = null;
  let voiceName: string | null = null;

  // A late joiner gets the current voice channel straight away.
  if (state === 'joined' && fresh.status === 'live' && fresh.vc_channel_id) {
    voiceLink = channelLink(fresh.guild_id, fresh.vc_channel_id);
    const guild = client.guilds.cache.get(fresh.guild_id);
    voiceName = guild?.channels.cache.get(fresh.vc_channel_id)?.name ?? null;
  }

  return { state, session: fresh, voiceLink, voiceName };
}

/* --------------------------------- start ----------------------------------- */

export async function startSession(client: Client, sessionId: number): Promise<void> {
  const session = sessions.byId(sessionId);
  if (!session || session.status !== 'scheduled') return;

  const guild = await soft('fetch guild', () => client.guilds.fetch(session.guild_id));
  if (!guild) return;

  // markLive only succeeds once, so a duplicated job can't send two rounds of DMs.
  if (!sessions.markLive(sessionId)) return;

  await assignVoiceChannel(client, sessionId);
  const live = sessions.byId(sessionId)!;

  const voiceChannel = live.vc_channel_id
    ? ((await soft('fetch vc', () => guild.channels.fetch(live.vc_channel_id!))) as VoiceChannel | null)
    : null;

  await refreshSessionMessage(client, sessionId);
  await notifyParticipants(client, guild, live, voiceChannel, getSettings(guild.id));
}

/** Pick the VC at start time (not at post time) and store the decision. */
export async function assignVoiceChannel(client: Client, sessionId: number): Promise<VoiceChannel | null> {
  const session = sessions.byId(sessionId);
  if (!session) return null;

  const guild = await soft('fetch guild', () => client.guilds.fetch(session.guild_id));
  if (!guild) return null;

  const settings = getSettings(guild.id);
  const attendees = sessions.participants(sessionId);
  const result = await pickVoiceChannel(guild, settings, attendees, sessionId);

  sessions.setVoice(sessionId, result.channelId, result.reason);
  log.info(`Session ${sessionId}: voice → ${result.channelId ?? 'none'} (${result.reason})`);
  return result.channel;
}

async function notifyParticipants(
  client: Client,
  guild: Guild,
  session: SessionRow,
  voiceChannel: VoiceChannel | null,
  settings: GuildSettings,
): Promise<void> {
  const participants = sessions.participants(session.id);
  const body = renderStartNotice(session, voiceChannel?.name ?? null, settings, client);

  const components = voiceChannel
    ? [
        new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder()
              .setLabel('Join Voice')
              .setEmoji('🔊')
              .setStyle(ButtonStyle.Link)
              .setURL(channelLink(guild.id, voiceChannel.id)),
          )
          .toJSON(),
      ]
    : [];

  let anyDelivered = false;
  for (const userId of participants) {
    // One notice per member per session, even across a restart.
    if (!sessions.markNotice(session.id, userId, 'start')) continue;

    const user = await soft(`fetch user ${userId}`, () => client.users.fetch(userId));
    if (!user) continue;

    const sent = await soft(`DM ${userId}`, () =>
      user.send({ content: body, components, allowedMentions: NO_MENTIONS }),
    );
    if (sent) anyDelivered = true;
  }

  // If nobody could be DM'd, the session post itself carries the link (it already
  // shows the VC name and a Join Voice button after refreshSessionMessage).
  if (!anyDelivered && participants.length > 0) {
    log.debug(`Session ${session.id}: no DMs delivered; the session post is the fallback.`);
  }
}

/* --------------------------------- closing --------------------------------- */

export async function closeSession(
  client: Client,
  sessionId: number,
  status: 'closed' | 'cancelled' = 'closed',
): Promise<void> {
  const session = sessions.byId(sessionId);
  if (!session) return;
  if (!sessions.close(sessionId, status)) return;

  cancel(JOB_START, String(sessionId));
  cancel(JOB_CLOSE, String(sessionId));

  const settings = getSettings(session.guild_id);
  const guild = await soft('fetch guild', () => client.guilds.fetch(session.guild_id));
  if (!guild) return;

  if (settings.games.deleteOnClose && session.message_id) {
    const channel = await fetchTextChannel(guild, session.channel_id);
    const message = channel
      ? await soft('fetch session message', () => channel.messages.fetch(session.message_id!))
      : null;
    if (message) {
      await soft('delete session message', () => message.delete());
      return;
    }
  }

  await refreshSessionMessage(client, sessionId);
}

/* --------------------------- boot-time recovery ---------------------------- */

/**
 * After a restart: re-queue jobs for anything still open and immediately
 * resolve sessions whose start or close time passed while we were down.
 * `schedule()` is idempotent on (kind, ref), so nothing is queued twice.
 */
export function recoverSessions(): void {
  for (const session of sessions.allActive()) {
    const settings = getSettings(session.guild_id);
    if (session.status === 'scheduled') {
      schedule({
        guildId: session.guild_id,
        kind: JOB_START,
        ref: String(session.id),
        runAt: session.start_at,
      });
    }
    schedule({
      guildId: session.guild_id,
      kind: JOB_CLOSE,
      ref: String(session.id),
      runAt: session.start_at + settings.games.durationMinutes * 60_000,
    });
  }
}

export function registerSessionJobs(): void {
  registerJob(JOB_START, async (client, job) => {
    await startSession(client, Number(job.ref));
  });
  registerJob(JOB_CLOSE, async (client, job) => {
    await closeSession(client, Number(job.ref), 'closed');
  });
}
