import {
  ActionRowBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  type Client,
  type Guild,
  type GuildMember,
} from 'discord.js';
import { getSettings, type GuildSettings } from '../db/settings.js';
import {
  bar,
  button,
  container,
  divider,
  heading,
  row,
  sectionWithThumb,
  statRow,
  text,
  timeline,
  trendLabel,
  TIMELINE_KEY,
} from '../core/ui.js';
import { Ids } from '../core/ids.js';
import { isAdmin, isOwner } from '../core/permissions.js';
import { formatDuration, formatLastActive, summarise, summariseMany, WINDOW_DAYS } from './summary.js';
import { store, recentDays, FULL_COVERAGE_SECONDS } from './store.js';
import { emojiFor } from '../util/emoji.js';
import { exemptions } from '../purge/policy.js';

export const BOARD_PAGE_SIZE = 10;

function avatar(member: GuildMember): string {
  return member.displayAvatarURL({ extension: 'png', size: 128 });
}

/** Live voice state, so nobody stares at 0m while sitting in a channel. */
function liveVoice(member: GuildMember): { inVoice: boolean; counting: boolean; sinceMs: number } {
  const channelId = member.guild.voiceStates.cache.get(member.id)?.channelId ?? null;
  if (!channelId) return { inVoice: false, counting: false, sinceMs: 0 };
  const startedAt = store.openVoiceSince(member.guild.id, member.id);
  return { inVoice: true, counting: startedAt !== null, sinceMs: startedAt ? Date.now() - startedAt : 0 };
}

/** "Tracking since 23 Nov" — a date means something; "day 1" does not. */
function trackingSince(guildId: string): string {
  const first = store.firstTrackedDay(guildId);
  if (!first) return 'Tracking starts now';
  const [year, month, day] = first.split('-').map(Number);
  const at = Math.floor(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12) / 1000);
  return `Tracking since <t:${at}:D>`;
}

/** Up to three channels, then a count — never a wall of mentions. */
export function describeScope(settings: GuildSettings): string {
  const summarise = (mode: string, ids: string[], allLabel: string, fallback: string): string => {
    if (mode === 'all') return allLabel;
    if (ids.length === 0) return fallback;
    const shown = ids.slice(0, 2).map((id) => `<#${id}>`).join(' ');
    return ids.length > 2 ? `${shown} +${ids.length - 2}` : shown;
  };

  const chat = summarise(settings.activity.textMode, settings.activity.textChannels, 'all chat', '#general');
  const voice = summarise(settings.activity.voiceMode, settings.activity.voiceChannels, 'all voice', 'none picked');
  return `${chat}  ·  ${voice}`;
}

/**
 * The member card. Figures are grouped two to a line with no per-stat icons:
 * a column of emoji made this unreadable, and Discord shrinks them next to
 * text anyway, so they cost clarity and gained nothing.
 */
export function renderMemberCard(member: GuildMember, viewer: GuildMember, client?: Client) {
  const settings = getSettings(member.guild.id);
  const summary = summarise(member.guild.id, member.id, settings);
  const exemption = exemptions.get(member.guild.id, member.id);
  const live = liveVoice(member);
  const admin = isAdmin(viewer);
  const fresh = summary.observedDays === 0 && summary.messages === 0 && summary.voiceSeconds === 0;

  // The sleeping marker only appears when it means something.
  const longQuiet = summary.daysSinceActive !== null && summary.daysSinceActive >= 7;
  const quietMark = longQuiet ? ` ${emojiFor(settings, 'quiet', client)}` : '';

  const lines = [
    `**${summary.score}**/100`,
    bar(summary.score),
    '',
    statRow([
      ['Voice', formatDuration(summary.voiceSeconds)],
      ['Messages', String(summary.messages)],
    ]),
    statRow([
      ['Active days', `${summary.activeDays}/${WINDOW_DAYS}`],
      ['Last active', `${formatLastActive(summary)}${quietMark}`],
    ]),
  ];

  if (!fresh) {
    lines.push(
      statRow([
        ['Trend', trendLabel(summary.trend.direction)],
        ['Likely quiet', `${summary.inactivityPercent}%`],
      ]),
    );
  }

  const body = container()
    .addTextDisplayComponents(heading(`${emojiFor(settings, 'sword', client)}  CAMELOT ACTIVITY`))
    .addSeparatorComponents(divider())
    .addSectionComponents(sectionWithThumb(`**${member.displayName}**\n${lines.join('\n')}`, avatar(member)));

  if (live.inVoice) {
    body.addTextDisplayComponents(
      text(
        live.counting
          ? `${emojiFor(settings, 'live', client)} In voice · counting · ${formatDuration(live.sinceMs / 1000)}`
          : `${emojiFor(settings, 'idle', client)} In voice · alone, so not counting`,
      ),
    );
  }

  if (!fresh) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(`${timeline(summary.timeline)}\n${TIMELINE_KEY}`));
  }

  if (exemption) {
    body.addTextDisplayComponents(
      text(`${emojiFor(settings, 'shield', client)} Away until <t:${Math.floor(exemption.until / 1000)}:D>`),
    );
  }

  body.addSeparatorComponents(divider());

  // Members see when it started. Admins also see what is being counted.
  body.addTextDisplayComponents(
    text(admin ? `${trackingSince(member.guild.id)}  ·  ${describeScope(settings)}` : trackingSince(member.guild.id)),
  );

  const actions = [button(Ids.activityRefresh(member.id), 'Refresh', ButtonStyle.Secondary)];
  if (admin) actions.push(button(Ids.activityBoard(0), 'Leaderboard', ButtonStyle.Secondary));
  if (isOwner(viewer) && member.id !== viewer.id) {
    actions.push(
      exemption
        ? button(Ids.activityAwayClear(member.id), 'Clear away', ButtonStyle.Secondary)
        : button(Ids.activityAway(member.id), 'Mark away', ButtonStyle.Secondary),
    );
  }
  body.addActionRowComponents(row(...actions));

  if (admin) {
    body.addActionRowComponents(
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(Ids.activityPickMember())
          .setPlaceholder('Look up someone else')
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );
  }

  return body;
}

export interface BoardEntry {
  userId: string;
  name: string;
  score: number;
  activeDays: number;
}

/**
 * Builds the board from people who are actually here and have actually done
 * something. Members are fetched rather than read from the cache: an uncached
 * member used to appear as "Someone who left", which was simply wrong — and
 * anyone genuinely gone is dropped rather than listed as a ghost.
 */
export async function buildBoard(guild: Guild, limit = 100): Promise<BoardEntry[]> {
  const settings = getSettings(guild.id);
  const days = recentDays(WINDOW_DAYS, settings.timezone);
  const userIds = store.membersWithActivity(guild.id, days).slice(0, 500);
  if (userIds.length === 0) return [];

  const missing = userIds.filter((id) => !guild.members.cache.has(id));
  if (missing.length > 0) {
    try {
      await guild.members.fetch({ user: missing.slice(0, 100) });
    } catch {
      /* fall through: anyone still unresolved is skipped below */
    }
  }

  return summariseMany(guild.id, userIds, settings)
    .map((summary) => {
      const member = guild.members.cache.get(summary.userId);
      if (!member || member.user.bot) return null;
      return {
        userId: summary.userId,
        name: member.displayName,
        score: summary.score,
        activeDays: summary.activeDays,
      };
    })
    .filter((entry): entry is BoardEntry => entry !== null)
    // A row of zeroes is not a ranking; leave them off until they do something.
    .filter((entry) => entry.score > 0 || entry.activeDays > 0)
    .sort((a, b) => b.score - a.score || b.activeDays - a.activeDays)
    .slice(0, limit);
}

export async function renderBoard(guild: Guild, page: number, viewer: GuildMember, client?: Client) {
  const settings = getSettings(guild.id);
  const entries = await buildBoard(guild);
  const pages = Math.max(1, Math.ceil(entries.length / BOARD_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const slice = entries.slice(current * BOARD_PAGE_SIZE, (current + 1) * BOARD_PAGE_SIZE);

  const body = container()
    .addTextDisplayComponents(heading(`${emojiFor(settings, 'crown', client)}  LEADERBOARD`, 'Last 30 days'))
    .addSeparatorComponents(divider());

  if (slice.length === 0) {
    body.addTextDisplayComponents(
      text('Nobody has clocked any activity yet. Talk in chat or sit in voice with someone.'),
    );
  } else {
    body.addTextDisplayComponents(
      text(
        slice
          .map((entry, index) => {
            const rank = current * BOARD_PAGE_SIZE + index + 1;
            return `\`${String(rank).padStart(2, ' ')}\`  **${entry.name}**  ·  ${entry.score}  ·  ${entry.activeDays}d`;
          })
          .join('\n'),
      ),
    );
  }

  body.addSeparatorComponents(divider()).addActionRowComponents(
    row(
      button(Ids.activityBoard(current - 1), 'Previous', ButtonStyle.Secondary).setDisabled(current === 0),
      button(Ids.activityBoard(current + 1), 'Next', ButtonStyle.Secondary).setDisabled(current >= pages - 1),
      button(Ids.activityRefresh(viewer.id), 'My activity', ButtonStyle.Primary),
    ),
  );

  return body;
}

/** Owner only: take someone out of inactivity review for a while. */
export function renderAwayPicker(member: GuildMember, client?: Client) {
  const settings = getSettings(member.guild.id);
  return container()
    .addTextDisplayComponents(
      heading(`${emojiFor(settings, 'shield', client)}  MARK AWAY`, `${member.displayName} skips inactivity reviews.`),
    )
    .addActionRowComponents(
      row(
        button(Ids.activityAwaySet(member.id, 7), '7 days', ButtonStyle.Secondary),
        button(Ids.activityAwaySet(member.id, 14), '14 days', ButtonStyle.Secondary),
        button(Ids.activityAwaySet(member.id, 30), '30 days', ButtonStyle.Secondary),
        button(Ids.activityAwaySet(member.id, 90), '90 days', ButtonStyle.Secondary),
      ),
    )
    .addActionRowComponents(row(button(Ids.activityView(member.id), 'Back', ButtonStyle.Secondary)));
}

void FULL_COVERAGE_SECONDS;
