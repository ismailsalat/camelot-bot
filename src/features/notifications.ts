import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type Guild,
} from 'discord.js';
import { sessions, subs, type SessionRow } from '../db/repos.js';
import { enabledGames, getSettings } from '../db/settings.js';
import { emojiFor, emojiKeyFor, parseEmoji, resolveEmoji } from '../util/emoji.js';
import { Ids } from '../interactions/ids.js';
import { messageLink, soft } from '../util/discord.js';
import { NO_MENTIONS } from '../util/mentions.js';
import { discordTime, isWithinQuietHours } from '../util/time.js';
import { log } from '../logger.js';

/** The ephemeral "Notifications" panel: pick games, or pause DMs entirely. */
export function buildNotificationPanel(guildId: string, userId: string) {
  const settings = getSettings(guildId);
  const chosen = new Set(subs.list(guildId, userId));
  const muted = subs.isMuted(guildId, userId);

  const games = enabledGames(settings);
  if (games.length === 0) {
    return { content: 'No games set up yet.', components: [] };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(Ids.notifyGames())
    .setPlaceholder('Games you want a heads-up for')
    .setMinValues(0)
    .setMaxValues(Math.max(1, games.length))
    .addOptions(
      games.slice(0, 25).map((game) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(game.name)
          .setValue(game.id)
          .setDefault(chosen.has(game.id));
        const emoji = parseEmoji(resolveEmoji(game.emoji, '🎮'));
        if (emoji) option.setEmoji(emoji.reactionKey);
        return option;
      }),
    );

  const button = new ButtonBuilder()
    .setCustomId(Ids.notifyMute())
    .setLabel(muted ? 'Resume DMs' : 'Pause DMs')
    .setEmoji(muted ? '🔔' : '🔕')
    .setStyle(muted ? ButtonStyle.Success : ButtonStyle.Secondary);

  const names = games.filter((game) => chosen.has(game.id)).map((game) => game.name);
  const summary = muted
    ? 'DMs paused. You still get a ping for sessions you join.'
    : names.length === 0
      ? "Nothing yet — pick what you care about."
      : `You'll hear about: ${names.join(', ')}`;

  return {
    content: summary,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON(),
      new ActionRowBuilder<ButtonBuilder>().addComponents(button).toJSON(),
    ],
  };
}

/** One quiet DM to people who asked about this game. Never a mass ping. */
export async function notifySubscribers(client: Client, guild: Guild, session: SessionRow): Promise<number> {
  const settings = getSettings(guild.id);
  if (!settings.features.notifications) return 0;

  if (
    settings.notifications.quietHoursEnabled &&
    isWithinQuietHours(
      Date.now(),
      settings.timezone,
      settings.notifications.quietStart,
      settings.notifications.quietEnd,
    )
  ) {
    log.debug(`Quiet hours in ${guild.id} — skipping session ${session.id} alerts.`);
    return 0;
  }

  const participants = new Set(sessions.participants(session.id));
  const targets = subs
    .subscribers(guild.id, session.game_id ?? session.game)
    .filter((userId) => userId !== session.organizer_id && !participants.has(userId))
    .filter((userId) => !subs.isMuted(guild.id, userId));

  if (targets.length === 0) return 0;

  const organizer = await soft('fetch organizer', () => guild.members.fetch(session.organizer_id));
  const body = `${emojiFor(settings, 'sword', client)} ${settings.notifications.dmText
    .replaceAll('{user}', organizer?.displayName ?? 'Someone')
    .replaceAll('{game}', `**${session.game}**`)
    .replaceAll('{time}', discordTime(session.start_at, 't'))}`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(Ids.sessionJoin(session.id))
      .setLabel("I'm Down")
      .setEmoji(emojiKeyFor(settings, 'check', client))
      .setStyle(ButtonStyle.Primary),
  );
  if (session.message_id) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Open')
        .setStyle(ButtonStyle.Link)
        .setURL(messageLink(guild.id, session.channel_id, session.message_id)),
    );
  }

  let delivered = 0;
  for (const userId of targets) {
    // One alert per member per session — a restart can't produce a second.
    if (!sessions.markNotice(session.id, userId, 'alert')) continue;
    const user = await soft(`fetch user ${userId}`, () => client.users.fetch(userId));
    if (!user) continue;
    const sent = await soft(`alert DM ${userId}`, () =>
      user.send({ content: body, components: [row.toJSON()], allowedMentions: NO_MENTIONS }),
    );
    if (sent) delivered += 1; // closed DMs fail quietly — no public fallback spam
  }
  return delivered;
}
