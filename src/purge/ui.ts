import {
  ActionRowBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type Guild,
  type GuildMember,
} from 'discord.js';
import { getSettings } from '../db/settings.js';
import { emojiFor } from '../util/emoji.js';
import {
  bar,
  button,
  container,
  divider,
  emojiButton,
  heading,
  row,
  sectionWithThumb,
  text,
  timeline,
  trendLabel,
  ACCENT_MUTED,
  statRow,
  TIMELINE_KEY,
} from '../core/ui.js';
import { Ids } from '../core/ids.js';
import { formatDuration, formatLastActive, summariseMany, WINDOW_DAYS, type MemberSummary } from '../activity/summary.js';
import {
  describeProtection,
  exemptions,
  isProtected,
  protectionFor,
  selectCandidates,
  type Candidate,
  type MemberFacts,
  type Scope,
} from './policy.js';
import { reviews, type ReviewSession } from './session.js';
import type { Verdict } from './execute.js';

/** Hard cap on a review queue — keeps the snapshot bounded and swiping instant. */
export const MAX_CANDIDATES = 100;

/** Slate blue for a card you can look at but not act on. */
const ACCENT_LOCKED = 0x5865f2;

export function renderStart(guild: Guild, counts?: Record<Scope, number>, client?: Client) {
  const settings = getSettings(guild.id);
  const label = (base: string, scope: Scope) =>
    counts ? `${base} (${counts[scope]})` : base;
  const mark = emojiFor(settings, 'purge', client);

  return container()
    .addTextDisplayComponents(heading(`${mark} THE PURGE`, 'Swipe through members, one at a time.'))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        [
          `Quiet for **${settings.purge.inactivityDays} days** counts as inactive.`,
          `New members get **${settings.activity.gracePeriodDays} days** before they show up.`,
          '',
          '**Nothing happens until you confirm at the very end.**',
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text('Who do you want to see?'))
    .addActionRowComponents(
      row(
        button(Ids.purgeStart('inactive'), label('Inactive only', 'inactive'), ButtonStyle.Primary),
        button(Ids.purgeStart('eligible'), label('Everyone I can remove', 'eligible'), ButtonStyle.Secondary),
        button(Ids.purgeStart('all'), label('Everyone', 'all'), ButtonStyle.Secondary),
      ),
    );
}

/** Gather candidates once. Nothing is re-queried while swiping. */
export function gatherCandidates(guild: Guild, scope: Scope, now = Date.now()): Candidate[] {
  const settings = getSettings(guild.id);
  const members = [...guild.members.cache.values()].filter((member) => !member.user.bot);
  const summaries = summariseMany(
    guild.id,
    members.map((member) => member.id),
    settings,
    now,
  );
  const byId = new Map(summaries.map((summary) => [summary.userId, summary]));

  const inputs = members.map((member) => {
    const facts: MemberFacts = {
      userId: member.id,
      isOwner: member.id === guild.ownerId,
      isBot: member.user.bot,
      roleIds: [...member.roles.cache.keys()],
      joinedAt: member.joinedTimestamp,
    };
    return {
      facts,
      summary: byId.get(member.id)!,
      protection: protectionFor(facts, settings, exemptions.get(guild.id, member.id, now), now),
    };
  });

  return selectCandidates(inputs, scope, settings, now).slice(0, MAX_CANDIDATES);
}

/** How many members each filter would show, so the buttons can say up front. */
export function scopeCounts(guild: Guild, now = Date.now()): Record<Scope, number> {
  return {
    inactive: gatherCandidates(guild, 'inactive', now).length,
    eligible: gatherCandidates(guild, 'eligible', now).length,
    all: gatherCandidates(guild, 'all', now).length,
  };
}

export function renderEmpty(scope: Scope) {
  const message =
    scope === 'inactive'
      ? "Nobody looks inactive — either everyone's around, or tracking needs more time."
      : 'Nobody to review here.';
  return container(ACCENT_MUTED)
    .addTextDisplayComponents(heading('THE PURGE', message))
    .addActionRowComponents(row(button(Ids.purgeResume(), 'Back', ButtonStyle.Secondary)));
}

export interface CardContext {
  session: ReviewSession;
  member: GuildMember;
  summary: MemberSummary;
  protection: ReturnType<typeof protectionFor>;
  index: number;
  total: number;
  decided: string | null;
  /** Set when Discord itself would refuse the kick — role order, permissions. */
  blocked?: string | null;
}

/** One member per card, built to be read in two seconds. */
export function renderCard(context: CardContext, client?: Client) {
  const { member, summary, protection, index, total } = context;
  const settings = getSettings(member.guild.id);
  const locked = isProtected(protection) || !!context.blocked;
  const protectionNote = describeProtection(protection);
  const reason = context.blocked ?? (protectionNote ? `${protectionNote}.` : null);

  const icon = (slot: Parameters<typeof emojiFor>[1]) => emojiFor(settings, slot, client);
  const longQuiet = summary.daysSinceActive !== null && summary.daysSinceActive >= 7;

  const stats = [
    `**${summary.score}**/100`,
    bar(summary.score),
    '',
    statRow([
      ['Voice', formatDuration(summary.voiceSeconds)],
      ['Messages', String(summary.messages)],
    ]),
    statRow([
      ['Active days', `${summary.activeDays}/${WINDOW_DAYS}`],
      ['Last active', `${formatLastActive(summary)}${longQuiet ? ` ${icon('quiet')}` : ''}`],
    ]),
    statRow([
      ['Trend', trendLabel(summary.trend.direction)],
      ['Likely quiet', `${summary.inactivityPercent}%`],
    ]),
  ];

  const body = container(locked ? ACCENT_LOCKED : undefined)
    .addTextDisplayComponents(heading(`${icon('purge')} THE PURGE`, `${index + 1} of ${total}`))
    .addSeparatorComponents(divider())
    .addSectionComponents(
      sectionWithThumb(
        `${member.toString()}  ·  **${member.displayName}**\n${stats.join('\n')}`,
        member.displayAvatarURL({ extension: 'png', size: 128 }),
      ),
    )
    .addTextDisplayComponents(text(`${timeline(summary.timeline)}\n${TIMELINE_KEY}`));

  if (summary.provisional) {
    body.addTextDisplayComponents(
      text(
        `⏳ **${summary.observedDays} fully tracked days so far** — the numbers are real, ` +
          `but there isn't enough history to call anyone inactive.`,
      ),
    );
  }

  // The whole point of this screen is a fast yes/no, so when the answer is
  // "you can't", say it loudly and offer the only move that makes sense.
  if (locked) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(`${icon('shield')} **Can't remove this one**\n${reason ?? 'Discord will not let me.'}`),
      );
  }

  if (context.decided) {
    body.addTextDisplayComponents(text(`_Marked: ${context.decided}._`));
  }

  body.addSeparatorComponents(divider());

  if (locked) {
    body.addActionRowComponents(
      row(
        button(Ids.purgeDecide('skip'), 'Next member →', ButtonStyle.Primary),
        button(Ids.purgeBack(), 'Back', ButtonStyle.Secondary).setDisabled(index === 0),
        button(Ids.purgeFinish(), 'Finish', ButtonStyle.Secondary),
      ),
    );
    return body;
  }

  body
    .addActionRowComponents(
      row(
        emojiButton(Ids.purgeDecide('keep'), 'Keep', settings, 'check', ButtonStyle.Success, client),
        emojiButton(Ids.purgeDecide('purge'), 'Purge', settings, 'x', ButtonStyle.Danger, client),
      ),
    )
    .addActionRowComponents(
      row(
        button(Ids.purgeBack(), 'Back', ButtonStyle.Secondary).setDisabled(index === 0),
        button(Ids.purgeDecide('skip'), 'Skip', ButtonStyle.Secondary),
        button(Ids.purgeFinish(), 'Finish', ButtonStyle.Primary),
      ),
    );

  return body;
}

export function renderSummary(session: ReviewSession, guild: Guild) {
  const tally = reviews.tally(session.id);
  const queued = reviews.queued(session.id);

  const body = container()
    .addTextDisplayComponents(heading('THE PURGE — COMPLETE'))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        [
          `Reviewed **${tally.reviewed}** of ${tally.total}`,
          `Keep **${tally.keep}**`,
          `Purge **${tally.purge}**`,
          `Skipped **${tally.skipped}**`,
        ].join('\n'),
      ),
    );

  if (queued.length > 0) {
    const names = queued
      .map((userId) => guild.members.cache.get(userId)?.displayName ?? `Unknown (${userId})`)
      .slice(0, 25);
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(`**Queued for removal**\n${names.map((name) => `· ${name}`).join('\n')}`));
  }

  const actions = [button(Ids.purgeResume(), 'Change decisions', ButtonStyle.Secondary)];
  if (queued.length > 0) actions.push(button(Ids.purgeConfirm(), `Remove ${queued.length}`, ButtonStyle.Danger));
  actions.push(button(Ids.purgeCancel(), 'Close', ButtonStyle.Secondary));

  body.addSeparatorComponents(divider()).addActionRowComponents(row(...actions));
  return body;
}

/** The last screen before anyone is removed. Shows exactly who, and any blocks. */
export function renderConfirm(verdicts: Verdict[]) {
  const ready = verdicts.filter((verdict) => verdict.ok);
  const blocked = verdicts.filter((verdict) => !verdict.ok);

  const body = container(0x8b3a3a)
    .addTextDisplayComponents(heading('CONFIRM REMOVAL', `${ready.length} member${ready.length === 1 ? '' : 's'}.`))
    .addSeparatorComponents(divider());

  if (ready.length > 0) {
    body.addTextDisplayComponents(
      text(ready.map((verdict) => `· ${verdict.member?.displayName ?? verdict.userId}`).join('\n')),
    );
  } else {
    body.addTextDisplayComponents(text('Nobody left to remove.'));
  }

  if (blocked.length > 0) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(
          `**Skipped — something changed**\n${blocked
            .map((verdict) => `· ${verdict.member?.displayName ?? verdict.userId} — ${verdict.detail}`)
            .join('\n')}`,
        ),
      );
  }

  const actions = [button(Ids.purgeCancel(), 'Cancel', ButtonStyle.Secondary)];
  if (ready.length > 0) {
    actions.unshift(button(Ids.purgeExecute(), ready.length >= 5 ? 'Type to confirm' : 'Remove them', ButtonStyle.Danger));
  }

  body.addSeparatorComponents(divider()).addActionRowComponents(row(...actions));
  return body;
}

/** A larger batch asks you to type the number, so it can't be a stray click. */
export function buildBatchModal(count: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(Ids.purgeExecute())
    .setTitle(`Remove ${count} members`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(Ids.purgeConfirmInput)
          .setLabel(`Type ${count} to confirm`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4),
      ),
    );
}

export function renderOutcome(outcomes: { name: string; success: boolean; detail: string }[]) {
  const removed = outcomes.filter((outcome) => outcome.success);
  const failed = outcomes.filter((outcome) => !outcome.success);

  const body = container(ACCENT_MUTED)
    .addTextDisplayComponents(heading('DONE', `${removed.length} removed.`))
    .addSeparatorComponents(divider());

  if (failed.length > 0) {
    body.addTextDisplayComponents(
      text(`**Couldn't remove**\n${failed.map((outcome) => `· ${outcome.name} — ${outcome.detail}`).join('\n')}`),
    );
  } else {
    body.addTextDisplayComponents(text('Nothing was announced publicly.'));
  }

  return body;
}
