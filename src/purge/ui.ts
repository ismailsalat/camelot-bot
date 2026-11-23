import {
  ActionRowBuilder,
  ButtonBuilder,
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
import type { Tier } from '../core/permissions.js';
import type { Verdict } from './execute.js';

/** Hard cap on a review queue — keeps the snapshot bounded and swiping instant. */
export const MAX_CANDIDATES = 100;

/** Slate blue for a card you can look at but not act on. */
const ACCENT_LOCKED = 0x5865f2;
/** Crimson for the screen that actually removes people. */
const ACCENT_DANGER = 0xef4444;

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
export function gatherCandidates(
  guild: Guild,
  scope: Scope,
  now = Date.now(),
  tier: Tier = 'admin',
): Candidate[] {
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

  return selectCandidates(inputs, scope, settings, now, tier).slice(0, MAX_CANDIDATES);
}

/** How many members each filter would show, so the buttons can say up front. */
export function scopeCounts(guild: Guild, now = Date.now(), tier: Tier = 'admin'): Record<Scope, number> {
  return {
    inactive: gatherCandidates(guild, 'inactive', now, tier).length,
    eligible: gatherCandidates(guild, 'eligible', now, tier).length,
    all: gatherCandidates(guild, 'all', now, tier).length,
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
  /** Decides whether an absolute role is a warning or a wall. */
  actorTier?: Tier;
}

/** One member per card, built to be read in two seconds. */
export function renderCard(context: CardContext, client?: Client) {
  const { member, summary, protection, index, total } = context;
  const settings = getSettings(member.guild.id);
  const tier: Tier = context.actorTier ?? 'admin';

  // Two different kinds of "no". A wall is Discord's rule or the owner's
  // locked list — not this admin's to move. A caution is the server's own
  // soft setting, which the person who wrote it can override.
  const wall =
    !!context.blocked || protection.kind === 'owner' || (protection.kind === 'absolute' && tier !== 'owner');
  const caution = !wall && isProtected(protection);
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

  const body = container(wall ? ACCENT_LOCKED : undefined)
    .addTextDisplayComponents(heading(`${icon('purge')} THE PURGE`, `${index + 1} of ${total}`))
    .addSeparatorComponents(divider())
    .addSectionComponents(
      sectionWithThumb(
        // A mention is clickable, so their profile is one tap away. Mentions
        // are suppressed at send time, so nobody gets pinged by a review.
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
  if (wall) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(`${icon('shield')} **Can't remove this one**\n${reason ?? 'Discord will not let me.'}`),
      );
  } else if (caution) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(
          `${icon('shield')} **Protected — but it's your call**\n${reason ?? 'Protected.'}\n` +
            `_That's a setting, not a rule. You can still remove them._`,
        ),
      );
  }

  if (context.decided) {
    body.addTextDisplayComponents(text(`_Marked: ${context.decided}._`));
  }

  body.addSeparatorComponents(divider());

  if (wall) {
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
        emojiButton(
          Ids.purgeDecide('purge'),
          caution ? 'Purge anyway' : 'Purge',
          settings,
          'x',
          ButtonStyle.Danger,
          client,
        ),
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

export function renderSummary(session: ReviewSession) {
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
    const names = queued.slice(0, 25).map((userId) => `<@${userId}>`);
    const more = queued.length > 25 ? `\n_…and ${queued.length - 25} more._` : '';
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(`**Queued for removal**\n${names.map((name) => `· ${name}`).join('\n')}${more}`),
      );
  }

  const actions = [button(Ids.purgeResume(), 'Change decisions', ButtonStyle.Secondary)];
  if (queued.length > 0) actions.push(button(Ids.purgeConfirm(), `Remove ${queued.length}`, ButtonStyle.Danger));
  actions.push(button(Ids.purgeCancel(), 'Close', ButtonStyle.Secondary));

  body.addSeparatorComponents(divider()).addActionRowComponents(row(...actions));
  return body;
}

/**
 * The last screen before anyone is removed.
 *
 * Three groups, because they mean different things: ready, flagged (Camelot
 * is unsure about its own data, and you may override), and blocked (Discord's
 * rules or the server's, which nobody overrides).
 */
export function renderConfirm(verdicts: Verdict[]) {
  // A mention and nothing else: Discord renders it as their name, so adding
  // the display name alongside would read "@Spatz · Spatz". A profile is one
  // tap away at the moment it matters most, and nothing pings — every send
  // suppresses mentions.
  const name = (verdict: Verdict) => `<@${verdict.userId}>`;
  const ready = verdicts.filter((verdict) => verdict.severity === 'ok');
  const flagged = verdicts.filter((verdict) => verdict.severity === 'warn');
  const blocked = verdicts.filter((verdict) => verdict.severity === 'block');

  const total = ready.length + flagged.length;
  const body = container(total > 0 ? ACCENT_DANGER : ACCENT_MUTED)
    .addTextDisplayComponents(heading('CONFIRM REMOVAL'))
    .addSeparatorComponents(divider());

  if (ready.length > 0) {
    body.addTextDisplayComponents(
      text(`**Ready — ${ready.length}**\n${ready.map((v) => `· ${name(v)}`).join('\n')}`),
    );
  }

  if (flagged.length > 0) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(
          `**Flagged — ${flagged.length}**\n` +
            `${flagged.map((v) => `· ${name(v)} — ${v.detail}`).join('\n')}\n` +
            `_These are cautions, not rules. Your call._`,
        ),
      );
  }

  if (blocked.length > 0) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(
          `**Can't be removed — ${blocked.length}**\n${blocked.map((v) => `· ${name(v)} — ${v.detail}`).join('\n')}`,
        ),
      );
  }

  if (total === 0) {
    body.addTextDisplayComponents(text('Nobody left to remove.'));
  }

  const actions: ButtonBuilder[] = [];
  if (ready.length > 0) {
    actions.push(button(Ids.purgeExecute('safe'), `Remove ${ready.length}`, ButtonStyle.Danger));
  }
  if (flagged.length > 0) {
    // Overriding goes through one more screen. Straight to the kick would make
    // the override the same single click as the safe path, which it is not.
    actions.push(button(Ids.purgeOverride(), `Remove all ${total} anyway`, ButtonStyle.Danger));
  }
  actions.push(button(Ids.purgeCancel(), 'Cancel', ButtonStyle.Secondary));

  body.addSeparatorComponents(divider()).addActionRowComponents(row(...actions));
  return body;
}

/** A larger batch asks you to type the number, so it can't be a stray click. */
export function buildBatchModal(count: number, mode: 'safe' | 'all'): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(Ids.purgeExecute(mode))
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

export function renderOutcome(outcomes: { userId: string; name: string; success: boolean; detail: string }[]) {
  const removed = outcomes.filter((outcome) => outcome.success);
  const failed = outcomes.filter((outcome) => !outcome.success);

  const body = container(ACCENT_MUTED)
    .addTextDisplayComponents(heading('DONE', `${removed.length} removed.`))
    .addSeparatorComponents(divider());

  if (failed.length > 0) {
    body.addTextDisplayComponents(
      text(
        `**Couldn't remove**\n${failed
          .map((outcome) => `· <@${outcome.userId}> — ${outcome.detail}`)
          .join('\n')}`,
      ),
    );
  } else {
    body.addTextDisplayComponents(text('Nothing was announced publicly.'));
  }

  return body;
}


/**
 * The override's own confirmation. Shown only when a flagged member is about
 * to be removed anyway, and it names each one with the caution attached, so
 * the thing being overridden is on screen at the moment of overriding it.
 */
export function renderOverrideConfirm(verdicts: Verdict[]) {
  const name = (verdict: Verdict) => `<@${verdict.userId}>`;
  const ready = verdicts.filter((verdict) => verdict.severity === 'ok');
  const flagged = verdicts.filter((verdict) => verdict.severity === 'warn');
  const total = ready.length + flagged.length;

  const body = container(ACCENT_DANGER)
    .addTextDisplayComponents(heading('ARE YOU SURE?', `${total} member${total === 1 ? '' : 's'} will be removed.`))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        `**Overriding ${flagged.length} caution${flagged.length === 1 ? '' : 's'}**\n` +
          flagged.map((verdict) => `· ${name(verdict)} — ${verdict.detail}`).join('\n'),
      ),
    );

  if (ready.length > 0) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(`**Plus ${ready.length} already clear**\n${ready.map((v) => `· ${name(v)}`).join('\n')}`),
      );
  }

  body
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text('This kicks them from the server. They can be re-invited.'))
    .addActionRowComponents(
      row(
        button(Ids.purgeExecute('all'), `Yes, remove ${total}`, ButtonStyle.Danger),
        button(Ids.purgeConfirm(), 'Back', ButtonStyle.Secondary),
        button(Ids.purgeCancel(), 'Cancel', ButtonStyle.Secondary),
      ),
    );

  return body;
}

/**
 * `/purge @user` — one named member, no queue. The same numbers as the review
 * card so the decision is made on the same evidence, and the same verdict
 * machinery so a wall is still a wall.
 */
export function renderOneCard(
  member: GuildMember,
  summary: MemberSummary,
  verdict: Verdict,
  actorId: string,
  client?: Client,
) {
  const settings = getSettings(member.guild.id);
  const icon = (slot: Parameters<typeof emojiFor>[1]) => emojiFor(settings, slot, client);
  const wall = verdict.severity === 'block';
  const caution = verdict.severity === 'warn';
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

  const body = container(wall ? ACCENT_LOCKED : ACCENT_DANGER)
    .addTextDisplayComponents(heading(`${icon('purge')} REVIEW ONE MEMBER`))
    .addSeparatorComponents(divider())
    .addSectionComponents(
      sectionWithThumb(
        `${member.toString()}  ·  **${member.displayName}**\n${stats.join('\n')}`,
        member.displayAvatarURL({ extension: 'png', size: 128 }),
      ),
    )
    .addTextDisplayComponents(text(`${timeline(summary.timeline)}\n${TIMELINE_KEY}`));

  if (wall) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(`${icon('shield')} **Can't remove this one**\n${verdict.detail}`));
  } else if (caution) {
    body
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(`${icon('shield')} **Heads up**\n${verdict.detail}\n_That's a caution, not a rule. You decide._`),
      );
  }

  body.addSeparatorComponents(divider());

  if (wall) {
    body.addActionRowComponents(row(button(Ids.purgeCancel(), 'Close', ButtonStyle.Secondary)));
    return body;
  }

  body.addActionRowComponents(
    row(
      button(Ids.purgeOneAsk(member.id, actorId), caution ? 'Remove anyway' : 'Remove', ButtonStyle.Danger),
      button(Ids.purgeCancel(), 'Cancel', ButtonStyle.Secondary),
    ),
  );

  return body;
}

/** The last click before one named member is removed. */
export function renderOneConfirm(member: GuildMember, verdict: Verdict, actorId: string, client?: Client) {
  const settings = getSettings(member.guild.id);
  const body = container(ACCENT_DANGER)
    .addTextDisplayComponents(
      heading(`${emojiFor(settings, 'purge', client)} ARE YOU SURE?`, `Remove ${member.displayName}?`),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(`${member.toString()} will be kicked from the server. They can be re-invited.`));

  if (verdict.severity === 'warn') {
    body.addTextDisplayComponents(text(`\n_Overriding: ${verdict.detail}_`));
  }

  body.addSeparatorComponents(divider()).addActionRowComponents(
    row(
      button(Ids.purgeOneGo(member.id, actorId), 'Yes, remove them', ButtonStyle.Danger),
      button(Ids.purgeOne(member.id, actorId), 'Back', ButtonStyle.Secondary),
      button(Ids.purgeCancel(), 'Cancel', ButtonStyle.Secondary),
    ),
  );

  return body;
}
