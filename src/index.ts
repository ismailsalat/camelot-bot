import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Guild,
  type Message,
} from 'discord.js';
import { streaming } from './streaming/service.js';
import { loadEnv } from './env.js';
import { log, setLogLevel } from './logger.js';
import { openDatabase } from './db/index.js';
import { getSettings, setByPath } from './db/settings.js';
import { clips } from './db/repos.js';
import { routeInteraction } from './core/router.js';
import { setHostPrefix } from './core/prefix.js';
import { publishCommands } from './core/publish.js';
import { handleTextCommand, looksLikeTextCommand } from './core/textCommands.js';
import { isModuleEnabled } from './core/registry.js';
import { onJoinGuild } from './core/adopt.js';
import { handleClipsMessage, handleClipsUpdate } from './features/mediaGuard.js';
import { enforceExclusiveVote } from './features/voting.js';
import { registerWeeklyJob, scheduleWeekly } from './features/clipOfWeek.js';
import { forgetGeneralChannel, flushOpenSessions, reconcileOnReady, trackMessage, trackVoiceState } from './activity/tracker.js';
import { registerUpkeepJobs, scheduleUpkeep, startCoverage, stopCoverage } from './activity/jobs.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { NO_MENTIONS } from './util/mentions.js';

function boot() {
  try {
    return loadEnv();
  } catch (error) {
    console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const env = boot();
setLogLevel(env.logLevel);
openDatabase(env.databasePath);
setHostPrefix(env.commandPrefix);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Privileged. Clips needs it to tell media from a text-only post, and
    // Activity needs message length. Removing it breaks both.
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    // Voice activity is read from state changes — never audio.
    GatewayIntentBits.GuildVoiceStates,
    // Needed so member lists and roles are available for Activity and Purge.
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  allowedMentions: NO_MENTIONS,
});

registerWeeklyJob();
registerUpkeepJobs();

client.once(Events.ClientReady, async (ready) => {
  log.info(`Logged in as ${ready.user.tag} in ${ready.guilds.cache.size} server(s).`);
  log.info(`Text commands use "${env.commandPrefix}" unless a server sets its own.`);

  for (const guild of ready.guilds.cache.values()) {
    await warmMemberCache(guild);
    onJoinGuild(guild);
    scheduleWeekly(guild.id);
    scheduleUpkeep(guild.id);
  }

  await streaming.start(client);
  reconcileOnReady(ready);
  startCoverage(ready);
  startScheduler(client);

  // Keeps Discord's command list in step with the code without a separate
  // deploy step. Does nothing when nothing has changed.
  await publishCommands({
    clientId: env.clientId,
    token: env.token,
    devGuildId: env.devGuildId,
  });
});

client.on(Events.GuildCreate, (guild: Guild) => {
  log.info(`Joined ${guild.name} (${guild.id}).`);
  void warmMemberCache(guild);
  onJoinGuild(guild);
  scheduleWeekly(guild.id);
  scheduleUpkeep(guild.id);
});

client.on(Events.InteractionCreate, (interaction) => {
  void routeInteraction(interaction);
});

client.on(Events.MessageCreate, (message: Message) => {
  if (!message.inGuild()) return;
  streaming.onMessage(message);

  // A text command is an instruction, not conversation: it gets answered, and
  // it does not earn activity. Otherwise `!allies` would be a way to farm the
  // very number it reports.
  const isCommand = looksLikeTextCommand(message);
  if (isCommand) {
    void handleTextCommand(message).catch((error) => log.error('Text command failed', error));
  }

  // Clips and Activity both read the same event; each checks its own module.
  void handleClipsMessage(message).catch((error) => log.error('Clips handler failed', error));

  if (!isCommand) {
    try {
      trackMessage(message);
    } catch (error) {
      log.error('Activity message tracking failed', error);
    }
  }
});

client.on(Events.MessageUpdate, (_old, updated) => {
  void (async () => {
    try {
      const message = updated.partial ? await updated.fetch() : updated;
      if (!message.inGuild()) return;
  streaming.onMessage(message);
      await handleClipsUpdate(message);
    } catch {
      /* message vanished */
    }
  })();
});

client.on(Events.MessageDelete, (message) => {
  if (message.id) {clips.markDeleted(message.id);streaming.onDelete(message.id);}
});

client.on(Events.MessageReactionAdd, (reaction, user) => {
  void enforceExclusiveVote(reaction, user).catch((error) => log.error('Vote handler failed', error));
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    trackVoiceState(oldState, newState);
  } catch (error) {
    log.error('Voice tracking failed', error);
  }
});

client.on(Events.ChannelDelete, (channel) => {
  if (channel.isDMBased()) return;
  forgetChannel(channel.guild.id, channel.id);
});

client.on(Events.Error, (error) => log.error('Gateway error', error));
client.on(Events.Warn, (message) => log.warn(message));
client.rest.on('rateLimited', (info) => {
  log.warn(`Rate limited for ${info.timeToReset}ms on ${info.route}`);
});

/**
 * Pull the member list once at boot. Almost everything — the voice head-count,
 * the leaderboard, role checks in The Purge — reads from this cache, and an
 * uncached member silently becomes a wrong answer rather than an error. Large
 * servers are skipped: there the cost outweighs the benefit, and the code
 * fetches on demand anyway.
 */
const WARM_CACHE_LIMIT = 2000;

async function warmMemberCache(guild: Guild): Promise<void> {
  if (guild.memberCount > WARM_CACHE_LIMIT) {
    log.info(`${guild.name} has ${guild.memberCount} members — fetching on demand instead.`);
    return;
  }
  try {
    const members = await guild.members.fetch();
    log.info(`Cached ${members.size} member(s) in ${guild.name}.`);
  } catch (error) {
    log.warn(`Could not fetch members for ${guild.name}. Is the Server Members intent on?`);
    log.debug(String(error));
  }
}

/** Keep settings honest when a configured channel disappears. */
function forgetChannel(guildId: string, channelId: string): void {
  const settings = getSettings(guildId);
  for (const key of ['clips', 'highlights'] as const) {
    if (settings.channels[key] === channelId) setByPath(guildId, `channels.${key}`, null);
  }
  for (const key of ['textChannels', 'voiceChannels', 'ignoredChannels'] as const) {
    if (settings.activity[key].includes(channelId)) {
      setByPath(
        guildId,
        `activity.${key}`,
        settings.activity[key].filter((id) => id !== channelId),
      );
    }
  }
  forgetGeneralChannel(guildId);
  void isModuleEnabled;
}

/* ------------------------------ shutdown ---------------------------------- */

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received — shutting down.`);
  stopCoverage();
  stopScheduler();
  // Bank voice time that is in progress, so a clean restart loses nothing.
  try {
    flushOpenSessions(client);
  } catch (error) {
    log.error('Could not flush voice sessions', error);
  }
  await streaming.close();
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason));
process.on('uncaughtException', (error) => log.error('Uncaught exception', error));

void client.login(env.token).catch((error) => {
  log.error('Login failed — check DISCORD_TOKEN and that the bot is invited.', error);
  process.exit(1);
});
