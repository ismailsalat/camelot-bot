import {
  MessageFlags,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { getSettings, setByPath, type EmojiSlot } from '../db/settings.js';
import { EMOJI_SLOTS } from '../db/settings.js';
import { Ids, parseId } from './ids.js';
import { canBotKick, canEditGroup, isAdmin, isOwner, tierOf } from './permissions.js';
import { runCommand, type CommandResult } from './dispatch.js';
import { commandByName, resolveCommand } from './registry.js';
import { isModuleEnabled } from './registry.js';
import { container, divider, errorNotice, heading, notice, text, V2_FLAGS, V2_PUBLIC } from './ui.js';
import { renderHelpCategory, renderHelpHome } from './help.js';
import {
  buildEmojiModal,
  buildNumberModal,
  buildPrefixModal,
  numberFieldByPath,
  renderGroup,
  renderHome as renderSettingsHome,
  wipeConfirm,
  type Group,
} from './settingsUi.js';
import { DELEGATABLE_GROUPS } from './permissions.js';
import { parseEmoji } from '../util/emoji.js';
import { store } from '../activity/store.js';
import { forgetGeneralChannel } from '../activity/tracker.js';
import { summarise } from '../activity/summary.js';
import * as activityUi from '../activity/ui.js';
import * as purgeUi from '../purge/ui.js';
import { exemptions, protectionFor, type MemberFacts, type Scope } from '../purge/policy.js';
import { reviews, type Decision } from '../purge/session.js';
import { executeKicks, revalidate } from '../purge/execute.js';
import { NO_MENTIONS } from '../util/mentions.js';
import { isValidPrefix } from '../env.js';
import { isSoftError, soft } from '../util/discord.js';
import { log } from '../logger.js';

type Any = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

const SAVED = 'Saved.';

export async function routeInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) return await onCommand(interaction);
    if (interaction.isButton()) return await onComponent(interaction);
    if (interaction.isAnySelectMenu()) return await onComponent(interaction);
    if (interaction.isModalSubmit()) return await onModal(interaction);
  } catch (error) {
    if (isSoftError(error)) {
      log.debug('Interaction expired — ignoring.');
      return;
    }
    log.error('Interaction failed', error);
    await replySafely(interaction, "That broke on my end. Try again.");
  }
}

async function replySafely(interaction: Interaction, message: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  try {
    const payload = {
      components: [errorNotice(message)],
      flags: V2_FLAGS,
      allowedMentions: NO_MENTIONS,
    } as never;
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    /* token gone */
  }
}

/**
 * Every V2 screen is sent the same way, so nothing ever mixes content with V2
 * and nothing ever pings. Cards carry mentions so a profile is one tap away —
 * suppressing them here is what keeps that from becoming a notification.
 */
async function show(interaction: Any, built: unknown, mode: 'update' | 'reply' = 'update'): Promise<void> {
  // A new reply asks to be ephemeral. An update must not: a card opened by a
  // text command is an ordinary channel message, and only IsComponentsV2 can
  // be changed on a message that already exists.
  const fresh = { components: [built], flags: V2_FLAGS, allowedMentions: NO_MENTIONS } as never;
  const edit = { components: [built], flags: V2_PUBLIC, allowedMentions: NO_MENTIONS } as never;

  if (mode === 'reply' || (!interaction.isModalSubmit() && !('update' in interaction))) {
    await interaction.reply(fresh);
    return;
  }
  if (interaction.isModalSubmit()) {
    if (interaction.isFromMessage()) await interaction.update(edit);
    else await interaction.reply(fresh);
    return;
  }
  await interaction.update(edit);
}

/**
 * A refusal always replies; it never updates. A text command's card is a
 * public message, so updating it would wipe the panel for everyone looking at
 * it because one person pressed a button they weren't allowed to.
 */
async function denied(interaction: Any, message: string): Promise<void> {
  const payload = {
    components: [errorNotice(message)],
    flags: V2_FLAGS,
    allowedMentions: NO_MENTIONS,
  } as never;
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

/* -------------------------------- commands --------------------------------- */

/** Renders whatever a command decided to show. Used by both ways of asking. */
export function payloadFor(result: CommandResult): Record<string, unknown> {
  const body =
    result.kind === 'card'
      ? result.body
      : result.kind === 'error'
        ? errorNotice(result.message)
        : notice(result.message);
  return { components: [body], flags: V2_FLAGS, allowedMentions: NO_MENTIONS };
}

async function onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'Use this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // An alias is a separate command as far as Discord is concerned; here it
  // becomes the one name the handlers know.
  const name = resolveCommand(interaction.commandName);
  if (!name) {
    await interaction.reply(payloadFor({ kind: 'error', message: 'I do not know that one.' }) as never);
    return;
  }

  const spec = commandByName(name);
  const target = spec?.userOption
    ? (interaction.options.getMember(spec.userOption.name) ?? null)
    : null;

  // Replied directly rather than deferred: Components V2 has to be set when
  // the message is created, and `deferReply` only accepts Ephemeral — so a
  // deferred placeholder could not become a V2 card afterwards.
  const result = await runCommand({
    name,
    member: interaction.member,
    guild: interaction.guild,
    client: interaction.client,
    target,
  });
  await interaction.reply(payloadFor(result) as never);
}

/* ------------------------------- components -------------------------------- */

async function onComponent(interaction: ButtonInteraction | AnySelectMenuInteraction): Promise<void> {
  const parsed = parseId(interaction.customId);
  if (!parsed || !interaction.inCachedGuild()) return;
  const { action, args } = parsed;
  const member = interaction.member;

  if (action.startsWith('h.')) return await onHelp(interaction, action, member);
  if (action.startsWith('s.')) return await onSettings(interaction, action, args, member);
  if (action.startsWith('a.')) return await onActivity(interaction, action, args, member);
  if (action.startsWith('p.')) return await onPurge(interaction, action, args, member);
}

async function onHelp(
  interaction: ButtonInteraction | AnySelectMenuInteraction,
  action: string,
  member: GuildMember,
): Promise<void> {
  if (action === 'h.home') return await show(interaction, renderHelpHome(member, interaction.client));
  if (action === 'h.cat' && interaction.isStringSelectMenu()) {
    const key = interaction.values[0] as Parameters<typeof renderHelpCategory>[1];
    return await show(interaction, renderHelpCategory(member, key));
  }
}

/* --------------------------------- settings -------------------------------- */

function guardGroup(member: GuildMember, group: string): boolean {
  return canEditGroup(member, group) || group === 'status';
}

async function onSettings(
  interaction: ButtonInteraction | AnySelectMenuInteraction,
  action: string,
  args: string[],
  member: GuildMember,
): Promise<void> {
  if (!isAdmin(member)) return await denied(interaction, 'Admins only.');
  const guildId = member.guild.id;

  switch (action) {
    case 's.home':
      return await show(interaction, renderSettingsHome(member));

    case 's.g': {
      const group = args[0] as Group;
      if (!guardGroup(member, group)) return await denied(interaction, 'That one is owner only.');
      return await show(interaction, renderGroup(member, group, interaction.client));
    }

    case 's.p': {
      if (!interaction.isStringSelectMenu()) return;
      const kind = args[0];

      if (kind === 'home') {
        const group = interaction.values[0] as Group;
        if (!guardGroup(member, group)) return await denied(interaction, 'That one is owner only.');
        return await show(interaction, renderGroup(member, group, interaction.client));
      }

      if (kind === 'activity') {
        const field = numberFieldByPath(interaction.values[0]!);
        if (!field) return;
        if (!guardGroup(member, 'activity')) return await denied(interaction, 'Not allowed.');
        return await interaction.showModal(buildNumberModal(field, getSettings(guildId)));
      }

      if (kind === 'emoji') {
        const slot = interaction.values[0]!;
        if (!EMOJI_SLOTS.includes(slot as EmojiSlot)) return;
        if (!guardGroup(member, 'emojis')) return await denied(interaction, 'Not allowed.');
        return await interaction.showModal(buildEmojiModal(slot as EmojiSlot, getSettings(guildId)));
      }

      if (kind === 'delegate') {
        if (!isOwner(member)) return await denied(interaction, 'Owner only.');
        const chosen = interaction.values.filter((value) =>
          (DELEGATABLE_GROUPS as readonly string[]).includes(value),
        );
        setByPath(guildId, 'permissions.adminEditable', chosen);
        return await show(interaction, renderGroup(member, 'permissions', interaction.client));
      }
      return;
    }

    case 's.t': {
      const path = args[0]!;
      const group: Group = path.startsWith('core')
        ? 'modules'
        : path.startsWith('activity')
          ? 'activity'
          : 'clips';
      // The modules screen is owner-only, and so is anything shown on it.
      if (group === 'modules' ? !isOwner(member) : !guardGroup(member, group)) {
        return await denied(interaction, group === 'modules' ? 'Owner only.' : 'Not allowed.');
      }
      const settings = getSettings(guildId);
      const current = !!getByPathLocal(settings, path);
      setByPath(guildId, path, !current);
      return await show(interaction, renderGroup(member, group, interaction.client));
    }

    case 's.x': {
      if (!isOwner(member)) return await denied(interaction, 'Owner only.');
      if (args[0] !== 'core.prefix') return;
      return await interaction.showModal(buildPrefixModal(getSettings(guildId), guildId));
    }

    case 's.mode': {
      if (!guardGroup(member, 'channels')) return await denied(interaction, 'Not allowed.');
      const path = args[0]!;
      const current = getByPathLocal(getSettings(guildId), path);
      setByPath(guildId, path, current === 'all' ? 'only' : 'all');
      return await show(interaction, renderGroup(member, 'channels', interaction.client));
    }

    case 's.m': {
      if (!isOwner(member)) return await denied(interaction, 'Owner only.');
      const key = args[0] as 'clips' | 'activity' | 'purge';
      const settings = getSettings(guildId);
      setByPath(guildId, `modules.${key}`, !settings.modules[key]);
      return await show(interaction, renderGroup(member, 'modules', interaction.client));
    }

    case 's.ch': {
      if (!interaction.isChannelSelectMenu()) return;
      const path = args[0]!;
      const group = path.startsWith('activity') ? 'channels' : 'channels';
      if (!guardGroup(member, group)) return await denied(interaction, 'Not allowed.');
      const single = path === 'channels.clips' || path === 'channels.highlights';
      setByPath(guildId, path, single ? (interaction.values[0] ?? null) : [...interaction.values]);
      forgetGeneralChannel(guildId);
      return await show(interaction, renderGroup(member, 'channels', interaction.client));
    }

    case 's.r': {
      if (!interaction.isRoleSelectMenu()) return;
      if (!isOwner(member)) return await denied(interaction, 'Owner only.');
      setByPath(guildId, args[0]!, [...interaction.values]);
      return await show(interaction, renderGroup(member, 'permissions', interaction.client));
    }

    case 's.wipe': {
      if (!isOwner(member)) return await denied(interaction, 'Owner only.');
      return await show(interaction, wipeConfirm());
    }

    case 's.wipe2': {
      if (!isOwner(member)) return await denied(interaction, 'Owner only.');
      store.wipe(guildId);
      return await show(
        interaction,
        container().addTextDisplayComponents(heading('CLEARED', 'All activity data is gone.')),
      );
    }
  }
}

function getByPathLocal(settings: unknown, path: string): unknown {
  let node: unknown = settings;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/* --------------------------------- activity -------------------------------- */

async function onActivity(
  interaction: ButtonInteraction | AnySelectMenuInteraction,
  action: string,
  args: string[],
  member: GuildMember,
): Promise<void> {
  const guild = member.guild;

  switch (action) {
    case 'a.home':
    case 'a.me':
      return await show(interaction, activityUi.renderMemberCard(member, member, interaction.client));

    case 'a.rf': {
      // Refresh whichever card you were looking at.
      const target = args[0] === member.id ? member : await soft('fetch member', () => guild.members.fetch(args[0]!));
      if (!target) return await show(interaction, notice('They are not in the server.'));
      if (target.id !== member.id && !isAdmin(member)) return await denied(interaction, 'Admins only.');
      return await show(interaction, activityUi.renderMemberCard(target, member, interaction.client));
    }

    case 'a.pick': {
      if (!interaction.isUserSelectMenu()) return;
      if (!isAdmin(member)) return await denied(interaction, 'Admins only.');
      const target = await soft('fetch member', () => guild.members.fetch(interaction.values[0]!));
      if (!target) return await show(interaction, notice('They are not in the server.'));
      return await show(interaction, activityUi.renderMemberCard(target, member, interaction.client));
    }

    case 'a.v': {
      const target = await soft('fetch member', () => guild.members.fetch(args[0]!));
      if (!target) return await show(interaction, notice('They are not in the server.'));
      if (target.id !== member.id && !isAdmin(member)) {
        return await denied(interaction, 'Admins only.');
      }
      return await show(interaction, activityUi.renderMemberCard(target, member, interaction.client));
    }

    case 'a.lb': {
      // Fetching members can take a beat, so acknowledge first.
      await interaction.deferUpdate();
      const board = await activityUi.renderBoard(guild, Number(args[0] ?? 0), member, interaction.client);
      await interaction.editReply({ components: [board], flags: V2_PUBLIC, allowedMentions: NO_MENTIONS } as never);
      return;
    }

    case 'a.away': {
      if (!isOwner(member)) return await denied(interaction, 'Owner only.');
      const target = await soft('fetch member', () => guild.members.fetch(args[0]!));
      if (!target) return await show(interaction, notice('They are not in the server.'));
      return await show(interaction, activityUi.renderAwayPicker(target, interaction.client));
    }

    case 'a.away2': {
      if (!isOwner(member)) return await denied(interaction, 'Owner only.');
      const userId = args[0]!;
      const days = Number(args[1] ?? 7);
      exemptions.set(guild.id, userId, Date.now() + days * 86_400_000, null, member.id);
      const target = await soft('fetch member', () => guild.members.fetch(userId));
      if (!target) return await show(interaction, notice(SAVED));
      return await show(interaction, activityUi.renderMemberCard(target, member, interaction.client));
    }

    case 'a.away0': {
      if (!isOwner(member)) return await denied(interaction, 'Owner only.');
      exemptions.clear(guild.id, args[0]!);
      const target = await soft('fetch member', () => guild.members.fetch(args[0]!));
      if (!target) return await show(interaction, notice(SAVED));
      return await show(interaction, activityUi.renderMemberCard(target, member, interaction.client));
    }
  }
}

/* ---------------------------------- purge ---------------------------------- */

/** Live review snapshots, keyed by session id. Bounded and rebuilt on demand. */
const snapshots = new Map<string, purgeUi.CardContext['summary'][]>();

async function showCard(
  interaction: Any,
  sessionId: string,
  member: GuildMember,
): Promise<void> {
  const session = reviews.get(sessionId);
  if (!session) return await show(interaction, notice('That review is over.'));

  const guild = member.guild;
  const settings = getSettings(guild.id);

  if (session.cursor >= session.candidates.length) {
    return await show(interaction, purgeUi.renderSummary(session));
  }

  const userId = session.candidates[session.cursor]!;
  const target = await soft('fetch member', () => guild.members.fetch(userId));
  if (!target) {
    // They left mid-review; move along rather than showing a blank card.
    reviews.setCursor(session.id, session.cursor + 1);
    return await showCard(interaction, sessionId, member);
  }

  const facts: MemberFacts = {
    userId,
    isOwner: userId === guild.ownerId,
    isBot: target.user.bot,
    roleIds: [...target.roles.cache.keys()],
    joinedAt: target.joinedTimestamp,
  };

  const decisions = reviews.decisions(session.id);
  const kickable = canBotKick(guild, target);

  await show(
    interaction,
    purgeUi.renderCard(
      {
        session,
        member: target,
        summary: summarise(guild.id, userId, settings),
        protection: protectionFor(facts, settings, exemptions.get(guild.id, userId)),
        index: session.cursor,
        total: session.candidates.length,
        decided: decisions.get(userId) ?? null,
        blocked: kickable.ok ? null : kickable.reason,
        actorTier: tierOf(member),
      },
      interaction.client,
    ),
  );
}

async function onPurge(
  interaction: ButtonInteraction | AnySelectMenuInteraction,
  action: string,
  args: string[],
  member: GuildMember,
): Promise<void> {
  const guild = member.guild;
  if (!isAdmin(member)) return await denied(interaction, 'Admins only.');

  switch (action) {
    case 'p.go1': {
      const scope = args[0] as Scope;
      await interaction.deferUpdate();

      const candidates = purgeUi.gatherCandidates(guild, scope, Date.now(), tierOf(member));
      if (candidates.length === 0) {
        await interaction.editReply({ components: [purgeUi.renderEmpty(scope)], flags: V2_PUBLIC, allowedMentions: NO_MENTIONS } as never);
        return;
      }

      const session = reviews.start(
        guild.id,
        member.id,
        scope,
        candidates.map((candidate) => candidate.facts.userId),
      );
      snapshots.delete(session.id);
      return await showCardDeferred(interaction, session.id, member);
    }

    case 'p.res': {
      const existing = reviews.findFor(guild.id, member.id);
      if (!existing) {
        return await show(
          interaction,
          purgeUi.renderStart(guild, purgeUi.scopeCounts(guild, Date.now(), tierOf(member)), interaction.client),
        );
      }
      reviews.setCursor(existing.id, 0);
      return await showCard(interaction, existing.id, member);
    }

    case 'p.d': {
      const session = reviews.findFor(guild.id, member.id);
      if (!session) return await show(interaction, notice('That review is over.'));
      if (session.actorId !== member.id) return await denied(interaction, 'That is someone else’s review.');

      const userId = session.candidates[session.cursor];
      const decision = args[0] as Decision;
      if (userId && decision !== 'skip') reviews.decide(session.id, userId, decision);
      reviews.setCursor(session.id, session.cursor + 1);
      return await showCard(interaction, session.id, member);
    }

    case 'p.back': {
      const session = reviews.findFor(guild.id, member.id);
      if (!session) return await show(interaction, notice('That review is over.'));
      reviews.setCursor(session.id, Math.max(0, session.cursor - 1));
      return await showCard(interaction, session.id, member);
    }

    case 'p.fin': {
      const session = reviews.findFor(guild.id, member.id);
      if (!session) return await show(interaction, notice('That review is over.'));
      return await show(interaction, purgeUi.renderSummary(session));
    }

    case 'p.ok': {
      const session = reviews.findFor(guild.id, member.id);
      if (!session) return await show(interaction, notice('That review is over.'));
      await interaction.deferUpdate();
      const queued = reviews.queued(session.id);
      const verdicts = await revalidate(guild, queued, member.id, { decidedAt: session.updatedAt });
      await interaction.editReply({
        components: [purgeUi.renderConfirm(verdicts)],
        flags: V2_PUBLIC,
        allowedMentions: NO_MENTIONS,
      } as never);
      return;
    }

    case 'p.go': {
      const session = reviews.findFor(guild.id, member.id);
      if (!session) return await show(interaction, notice('That review is over.'));

      const includeWarned = args[0] === 'all';
      const queued = reviews.queued(session.id);

      // Decide on the queued count, before any awaits: a modal has to be the
      // first response to the interaction, inside Discord's three seconds.
      if (queued.length >= 5) {
        return await interaction.showModal(
          purgeUi.buildBatchModal(queued.length, includeWarned ? 'all' : 'safe'),
        );
      }

      await interaction.deferUpdate();
      const verdicts = await revalidate(guild, queued, member.id, { decidedAt: session.updatedAt });
      const outcomes = await executeKicks(guild, verdicts, member.id, 'Camelot review', { includeWarned });
      reviews.finish(session.id);
      await interaction.editReply({
        components: [purgeUi.renderOutcome(outcomes)],
        flags: V2_PUBLIC,
        allowedMentions: NO_MENTIONS,
      } as never);
      return;
    }

    case 'p.ovr': {
      // The override's own confirmation. Re-checked here rather than trusting
      // the previous screen, because the answer can change between clicks.
      const session = reviews.findFor(guild.id, member.id);
      if (!session) return await show(interaction, notice('That review is over.'));
      await interaction.deferUpdate();
      const verdicts = await revalidate(guild, reviews.queued(session.id), member.id, {
        decidedAt: session.updatedAt,
      });
      await interaction.editReply({
        components: [purgeUi.renderOverrideConfirm(verdicts)],
        flags: V2_PUBLIC,
        allowedMentions: NO_MENTIONS,
      } as never);
      return;
    }

    /* --- one named member, from `/purge @user` or `!purge @user` --- */

    case 'p.1':
    case 'p.1a': {
      const [userId, actorId] = args;
      if (!userId || actorId !== member.id) {
        return await denied(interaction, 'That panel belongs to whoever opened it.');
      }
      const target = await soft('fetch member', () => guild.members.fetch(userId));
      if (!target) return await show(interaction, notice('They are not in the server.'));

      const verdicts = await revalidate(guild, [userId], member.id, {});
      const verdict = verdicts[0];
      if (!verdict) return await show(interaction, notice('Could not check that member.'));

      if (action === 'p.1a' && verdict.severity !== 'block') {
        return await show(interaction, purgeUi.renderOneConfirm(target, verdict, member.id, interaction.client));
      }
      return await show(
        interaction,
        purgeUi.renderOneCard(
          target,
          summarise(guild.id, userId, getSettings(guild.id)),
          verdict,
          member.id,
          interaction.client,
        ),
      );
    }

    case 'p.1g': {
      const [userId, actorId] = args;
      if (!userId || actorId !== member.id) {
        return await denied(interaction, 'That panel belongs to whoever opened it.');
      }
      await interaction.deferUpdate();

      const verdicts = await revalidate(guild, [userId], member.id, {});
      // Confirmed twice by an admin who saw the caution, so warnings count as
      // overridden. A hard block is still never overridable.
      const outcomes = await executeKicks(guild, verdicts, member.id, 'Camelot — removed by admin', {
        includeWarned: true,
      });

      const body =
        outcomes.length > 0
          ? purgeUi.renderOutcome(outcomes)
          : notice(verdicts[0]?.detail ?? 'Nothing changed. Nobody was removed.');
      await interaction.editReply({ components: [body], flags: V2_PUBLIC, allowedMentions: NO_MENTIONS } as never);
      return;
    }

    case 'p.no': {
      const session = reviews.findFor(guild.id, member.id);
      if (session) reviews.finish(session.id);
      return await show(interaction, notice('Closed. Nobody was removed.'));
    }

    case 'p.list': {
      const session = reviews.findFor(guild.id, member.id);
      if (!session) return await show(interaction, notice('That review is over.'));
      return await show(interaction, purgeUi.renderSummary(session));
    }
  }
  void args;
}

/** After deferUpdate the reply has to be edited rather than updated. */
async function showCardDeferred(
  interaction: ButtonInteraction | AnySelectMenuInteraction,
  sessionId: string,
  member: GuildMember,
): Promise<void> {
  const session = reviews.get(sessionId);
  if (!session) return;
  const guild = member.guild;
  const settings = getSettings(guild.id);
  const userId = session.candidates[session.cursor];
  if (!userId) {
    await interaction.editReply({ components: [purgeUi.renderSummary(session)], flags: V2_PUBLIC, allowedMentions: NO_MENTIONS } as never);
    return;
  }
  const target = await soft('fetch member', () => guild.members.fetch(userId));
  if (!target) return;

  const facts: MemberFacts = {
    userId,
    isOwner: userId === guild.ownerId,
    isBot: target.user.bot,
    roleIds: [...target.roles.cache.keys()],
    joinedAt: target.joinedTimestamp,
  };

  const kickable = canBotKick(guild, target);
  await interaction.editReply({
    components: [
      purgeUi.renderCard(
        {
          session,
          member: target,
          summary: summarise(guild.id, userId, settings),
          protection: protectionFor(facts, settings, exemptions.get(guild.id, userId)),
          index: session.cursor,
          total: session.candidates.length,
          decided: null,
          blocked: kickable.ok ? null : kickable.reason,
          actorTier: tierOf(member),
        },
        interaction.client,
      ),
    ],
    flags: V2_PUBLIC,
    allowedMentions: NO_MENTIONS,
  } as never);
}

/* ---------------------------------- modals --------------------------------- */

async function onModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parsed = parseId(interaction.customId);
  if (!parsed || !interaction.inCachedGuild()) return;
  const { action, args } = parsed;
  const member = interaction.member;

  if (action === 's.n') {
    if (!isAdmin(member)) return;
    const field = numberFieldByPath(args[0]!);
    if (!field) return;
    const raw = Number(interaction.fields.getTextInputValue(Ids.settingsInput).trim());
    if (!Number.isFinite(raw) || raw < field.min || raw > field.max) {
      return await show(interaction, errorNotice(`Give me a number between ${field.min} and ${field.max}.`));
    }
    setByPath(member.guild.id, field.path, Math.round(raw));
    const group: Group = field.path.startsWith('purge') ? 'activity' : 'activity';
    return await show(interaction, renderGroup(member, group, interaction.client));
  }

  if (action === 's.e') {
    if (!isAdmin(member)) return;
    const slot = args[0]!;
    if (!EMOJI_SLOTS.includes(slot as EmojiSlot)) return;
    const raw = interaction.fields.getTextInputValue(Ids.settingsInput).trim();
    const emoji = parseEmoji(raw);
    if (!emoji) return await show(interaction, errorNotice("That didn't parse. Paste the emoji, or <:Name:id>."));
    setByPath(member.guild.id, `emojis.${slot}`, emoji.display);
    return await show(interaction, renderGroup(member, 'emojis', interaction.client));
  }

  if (action === 's.x') {
    if (!isOwner(member)) return await denied(interaction, 'Owner only.');
    if (args[0] !== 'core.prefix') return;

    const raw = interaction.fields.getTextInputValue(Ids.settingsInput).trim();
    // Blank hands the server back to whatever the host set, which is the only
    // way to undo a custom prefix without guessing what the default was.
    if (raw === '') {
      setByPath(member.guild.id, 'core.prefix', null);
      return await show(interaction, renderGroup(member, 'modules', interaction.client));
    }
    if (!isValidPrefix(raw)) {
      return await show(
        interaction,
        errorNotice(
          'That prefix will not work. Use 1-3 symbols such as `!`, `?` or `$` — ' +
            'not letters, and not `/`, `@`, `#` or `<`, which Discord treats specially.',
        ),
      );
    }
    setByPath(member.guild.id, 'core.prefix', raw);
    return await show(interaction, renderGroup(member, 'modules', interaction.client));
  }

  if (action === 'p.go') {
    if (!isAdmin(member)) return;
    const session = reviews.findFor(member.guild.id, member.id);
    if (!session) return await show(interaction, notice('That review is over.'));

    const includeWarned = args[0] === 'all';
    const typed = interaction.fields.getTextInputValue(Ids.purgeConfirmInput).trim();
    const queued = reviews.queued(session.id);

    if (Number(typed) !== queued.length) {
      return await show(interaction, errorNotice(`Type ${queued.length} to confirm. Nothing was removed.`));
    }

    await interaction.deferUpdate();
    const verdicts = await revalidate(member.guild, queued, member.id, { decidedAt: session.updatedAt });
    const outcomes = await executeKicks(member.guild, verdicts, member.id, 'Camelot review', {
      includeWarned,
    });
    reviews.finish(session.id);
    await interaction.editReply({ components: [purgeUi.renderOutcome(outcomes)], flags: V2_PUBLIC, allowedMentions: NO_MENTIONS } as never);
  }
}

export { snapshots };
