import {
  MessageFlags,
  PermissionFlagsBits,
  type AnySelectMenuInteraction,
  type Client,
  type ButtonInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  gameById,
  getSettings,
  getByPath,
  makeGameId,
  setByPath,
  setGames,
  type GameEntry,
} from '../db/settings.js';
import { buildAddGameModal, buildEditGameModal, renderGamesHome } from '../ui/gamesUi.js';
import { buildEmojiModal, defaultEmojis, isEmojiSlot, renderEmojiHome } from '../ui/emojiUi.js';
import { parseEmoji } from '../util/emoji.js';
import { subs } from '../db/repos.js';
import { handleCamelotCommand } from '../commands/camelot.js';
import { CUSTOM_CATEGORIES, fieldByPath, parseFieldValue, type CategoryKey } from '../commands/fields.js';
import { buildNotificationPanel, notifySubscribers } from '../features/notifications.js';
import { postPanel } from '../features/panel.js';
import { scheduleWeekly } from '../features/clipOfWeek.js';
import {
  assignVoiceChannel,
  closeSession,
  createSession,
  refreshSessionMessage,
  toggleJoin,
} from '../features/sessions.js';
import { sessions } from '../db/repos.js';
import {
  buildFieldModal,
  renderCategory,
  renderFieldEditor,
  renderSettingsHome,
  renderSetup,
  SETUP_HEADER,
} from '../ui/settingsUi.js';
import { buildCustomTimeModal, renderGameStep, renderTimeStep } from './startFlow.js';
import { Ids, parseId } from './ids.js';
import { channelLink, isSoftError } from '../util/discord.js';
import { parseTimeInput } from '../util/time.js';
import { log } from '../logger.js';

const EPHEMERAL = MessageFlags.Ephemeral;

/** Games and Emojis have their own screens; the rest share the generic one. */
function renderForCategory(category: CategoryKey, guildId: string, client: Client) {
  const settings = getSettings(guildId);
  if (category === 'gameList') return renderGamesHome(settings, client);
  if (category === 'emojis') return renderEmojiHome(settings, client);
  return renderCategory(category, settings);
}

/** Remembers which settings page a member is on, so "Back" lands correctly. */
const lastCategory = new Map<string, CategoryKey>();

export async function routeInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'camelot') await handleCamelotCommand(interaction);
      return;
    }
    if (interaction.isButton()) return await onButton(interaction);
    if (interaction.isAnySelectMenu()) return await onSelect(interaction);
    if (interaction.isModalSubmit()) return await onModal(interaction);
  } catch (error) {
    if (isSoftError(error)) {
      log.debug('Interaction expired or lost permission — ignoring.');
      return;
    }
    log.error('Interaction failed', error);
    await replySafely(interaction, 'That broke on my end. Try again.');
  }
}

async function replySafely(interaction: Interaction, content: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: EPHEMERAL });
    else await interaction.reply({ content, flags: EPHEMERAL });
  } catch {
    /* the interaction token is gone; nothing useful left to do */
  }
}

function isAdmin(interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction): boolean {
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

/* --------------------------------- buttons --------------------------------- */

async function onButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseId(interaction.customId);
  if (!parsed) return;
  const { action, args } = parsed;

  switch (action) {
    case 'panel.start': {
      if (!interaction.inCachedGuild()) return;
      const settings = getSettings(interaction.guildId);
      if (!settings.features.sessions) {
        await interaction.reply({ content: 'Sessions are off right now.', flags: EPHEMERAL });
        return;
      }
      await interaction.reply({ ...renderGameStep(settings, interaction.client), flags: EPHEMERAL });
      return;
    }

    case 'panel.notify': {
      if (!interaction.inCachedGuild()) return;
      await interaction.reply({
        ...buildNotificationPanel(interaction.guildId, interaction.user.id),
        flags: EPHEMERAL,
      });
      return;
    }

    case 'pick.time': {
      if (!interaction.inCachedGuild()) return;
      const game = resolveGame(interaction.guildId, args[0]);
      if (!game) {
        await interaction.reply({ content: 'That game is gone. Try again.', flags: EPHEMERAL });
        return;
      }
      const minutes = Number(args[1] ?? 0);
      await startSessionFromInteraction(interaction, game, Date.now() + minutes * 60_000);
      return;
    }

    case 'pick.custom': {
      if (!interaction.inCachedGuild()) return;
      const game = resolveGame(interaction.guildId, args[0]);
      if (!game) {
        await interaction.reply({ content: 'That game is gone. Try again.', flags: EPHEMERAL });
        return;
      }
      await interaction.showModal(buildCustomTimeModal(game));
      return;
    }

    case 'sess.join': {
      await onJoin(interaction, Number(args[0]));
      return;
    }

    case 'sess.vc': {
      const sessionId = Number(args[0]);
      const session = sessions.byId(sessionId);
      if (!session) return;
      if (interaction.user.id !== session.organizer_id && !isAdmin(interaction)) {
        await interaction.reply({ content: 'Only whoever started it can do that.', flags: EPHEMERAL });
        return;
      }
      await interaction.deferReply({ flags: EPHEMERAL });
      const channel = await assignVoiceChannel(interaction.client, sessionId);
      await refreshSessionMessage(interaction.client, sessionId);
      await interaction.editReply(
        channel
          ? `Got **${channel.name}**.`
          : `Still nothing free — ${sessions.byId(sessionId)?.vc_reason ?? 'no channel fits'}.`,
      );
      return;
    }

    case 'sess.cancel': {
      const sessionId = Number(args[0]);
      const session = sessions.byId(sessionId);
      if (!session) return;
      if (interaction.user.id !== session.organizer_id && !isAdmin(interaction)) {
        await interaction.reply({ content: 'Only whoever started it can call it off.', flags: EPHEMERAL });
        return;
      }
      await closeSession(interaction.client, sessionId, 'cancelled');
      await interaction.reply({ content: 'Called off.', flags: EPHEMERAL });
      return;
    }

    case 'notify.mute': {
      if (!interaction.inCachedGuild()) return;
      const muted = subs.isMuted(interaction.guildId, interaction.user.id);
      subs.setMuted(interaction.guildId, interaction.user.id, !muted);
      await interaction.update(buildNotificationPanel(interaction.guildId, interaction.user.id));
      return;
    }

    case 'set.toggle': {
      if (!interaction.inCachedGuild() || !isAdmin(interaction)) return;
      const path = args[0]!;
      const field = fieldByPath(path);
      if (!field) return;
      const current = !!getByPath(getSettings(interaction.guildId), path);
      const settings = setByPath(interaction.guildId, path, !current);
      await afterSettingsChange(interaction, path);
      await interaction.update(renderCategory(field.category, settings, `**${field.label}** is now ${!current ? 'on' : 'off'}.`));
      lastCategory.set(interaction.user.id, field.category);
      return;
    }

    case 'games.add': {
      if (!interaction.inCachedGuild() || !isAdmin(interaction)) return;
      await interaction.showModal(buildAddGameModal());
      return;
    }

    case 'games.editm': {
      if (!interaction.inCachedGuild() || !isAdmin(interaction)) return;
      const game = gameById(getSettings(interaction.guildId), args[0]!);
      if (!game) return;
      await interaction.showModal(buildEditGameModal(game));
      return;
    }

    case 'games.toggle':
    case 'games.del':
    case 'games.up':
    case 'games.down': {
      if (!interaction.inCachedGuild() || !isAdmin(interaction)) return;
      const id = args[0]!;
      const settings = getSettings(interaction.guildId);
      const list = [...settings.games.list];
      const index = list.findIndex((game) => game.id === id);
      if (index === -1) return;

      let note: string;
      if (action === 'games.toggle') {
        const game = list[index]!;
        list[index] = { ...game, enabled: !game.enabled };
        note = `${game.name} is now ${game.enabled ? 'hidden' : 'back'}.`;
      } else if (action === 'games.del') {
        note = `Removed ${list[index]!.name}.`;
        list.splice(index, 1);
      } else {
        const target = action === 'games.up' ? index - 1 : index + 1;
        if (target < 0 || target >= list.length) return;
        [list[index], list[target]] = [list[target]!, list[index]!];
        note = 'Moved.';
      }

      const next = setGames(interaction.guildId, list);
      await interaction.update(
        renderGamesHome(next, interaction.client, action === 'games.del' ? undefined : id, note),
      );
      return;
    }

    case 'emoji.reset': {
      if (!interaction.inCachedGuild() || !isAdmin(interaction)) return;
      const next = setByPath(interaction.guildId, 'emojis', defaultEmojis());
      await interaction.update(renderEmojiHome(next, interaction.client, 'Back to defaults.'));
      return;
    }

    case 'set.back': {
      if (!interaction.inCachedGuild()) return;
      const settings = getSettings(interaction.guildId);
      const category = lastCategory.get(interaction.user.id);
      await interaction.update(
        category
          ? renderForCategory(category, interaction.guildId, interaction.client)
          : renderSettingsHome(settings),
      );
      if (category) lastCategory.delete(interaction.user.id);
      return;
    }

    default:
      log.debug(`Unhandled button ${interaction.customId}`);
  }
}

/* ----------------------------- the "I'm Down" tap --------------------------- */

async function onJoin(interaction: ButtonInteraction, sessionId: number): Promise<void> {
  const session = sessions.byId(sessionId);
  if (!session) {
    await interaction.reply({ content: 'That one is long gone.', flags: EPHEMERAL });
    return;
  }
  if (session.status === 'closed' || session.status === 'cancelled') {
    await interaction.reply({ content: 'That one already ended.', flags: EPHEMERAL });
    return;
  }

  // Acknowledge straight away: the message edit happens in the background.
  await interaction.deferReply({ flags: EPHEMERAL });
  const outcome = await toggleJoin(interaction.client, sessionId, interaction.user.id);
  if (!outcome) {
    await interaction.editReply('That one already ended.');
    return;
  }

  const settings = getSettings(session.guild_id);

  if (outcome.state === 'left') {
    await interaction.editReply(settings.copy.left);
    return;
  }

  if (outcome.voiceLink) {
    await interaction.editReply(
      `${settings.copy.joined} They're in **${outcome.voiceName ?? 'voice'}** — ${outcome.voiceLink}`,
    );
    return;
  }

  await interaction.editReply(
    outcome.session.status === 'live'
      ? `${settings.copy.joined} ${settings.copy.noVoice}`
      : `${settings.copy.joined} I'll ping you when it starts.`,
  );
}

/* --------------------------------- selects --------------------------------- */

async function onSelect(interaction: AnySelectMenuInteraction): Promise<void> {
  const parsed = parseId(interaction.customId);
  if (!parsed) return;
  const { action, args } = parsed;

  switch (action) {
    case 'pick.game': {
      if (!interaction.isStringSelectMenu() || !interaction.inCachedGuild()) return;
      const game = resolveGame(interaction.guildId, interaction.values[0]);
      if (!game) {
        await interaction.update({ content: 'That game is gone. Try again.', components: [] });
        return;
      }
      const settings = getSettings(interaction.guildId);
      // No quick options configured? Go straight to the modal.
      if (settings.games.quickOffsets.length === 0 && settings.games.allowCustomTime) {
        await interaction.showModal(buildCustomTimeModal(game));
        return;
      }
      await interaction.update(renderTimeStep(game, settings, interaction.client));
      return;
    }

    case 'notify.games': {
      if (!interaction.isStringSelectMenu() || !interaction.inCachedGuild()) return;
      subs.set(interaction.guildId, interaction.user.id, interaction.values);
      await interaction.update(buildNotificationPanel(interaction.guildId, interaction.user.id));
      return;
    }

    case 'set.cat': {
      if (!interaction.isStringSelectMenu() || !interaction.inCachedGuild() || !isAdmin(interaction)) return;
      const category = interaction.values[0] as CategoryKey;
      lastCategory.set(interaction.user.id, category);
      await interaction.update(renderForCategory(category, interaction.guildId, interaction.client));
      return;
    }

    case 'games.pick': {
      if (!interaction.isStringSelectMenu() || !interaction.inCachedGuild() || !isAdmin(interaction)) return;
      await interaction.update(
        renderGamesHome(getSettings(interaction.guildId), interaction.client, interaction.values[0]),
      );
      return;
    }

    case 'emoji.pick': {
      if (!interaction.isStringSelectMenu() || !interaction.inCachedGuild() || !isAdmin(interaction)) return;
      const slot = interaction.values[0]!;
      if (!isEmojiSlot(slot)) return;
      await interaction.showModal(buildEmojiModal(slot, getSettings(interaction.guildId)));
      return;
    }

    case 'set.field': {
      if (!interaction.isStringSelectMenu() || !interaction.inCachedGuild() || !isAdmin(interaction)) return;
      const path = interaction.values[0]!;
      const field = fieldByPath(path);
      if (!field) return;
      lastCategory.set(interaction.user.id, field.category);

      if (field.type === 'boolean') {
        const current = !!getByPath(getSettings(interaction.guildId), path);
        const settings = setByPath(interaction.guildId, path, !current);
        await afterSettingsChange(interaction, path);
        await interaction.update(
          renderCategory(field.category, settings, `**${field.label}** is now ${!current ? 'on' : 'off'}.`),
        );
        return;
      }

      if (field.type === 'channel' || field.type === 'channels' || field.type === 'voiceChannels' || field.type === 'roles' || field.type === 'choice') {
        await interaction.update(renderFieldEditor(field, getSettings(interaction.guildId)));
        return;
      }

      await interaction.showModal(buildFieldModal(field, getSettings(interaction.guildId)));
      return;
    }

    case 'set.chan': {
      if (!interaction.isChannelSelectMenu() || !interaction.inCachedGuild() || !isAdmin(interaction)) return;
      const path = args[0]!;
      const field = fieldByPath(path);
      const ids = [...interaction.values];
      const value = field?.type === 'channel' ? (ids[0] ?? null) : ids;
      setByPath(interaction.guildId, path, value);
      await afterSettingsChange(interaction, path);
      await renderAfterEdit(interaction, path);
      return;
    }

    case 'set.roles': {
      if (!interaction.isRoleSelectMenu() || !interaction.inCachedGuild() || !isAdmin(interaction)) return;
      setByPath(interaction.guildId, args[0]!, [...interaction.values]);
      await renderAfterEdit(interaction, args[0]!);
      return;
    }

    case 'set.choice': {
      if (!interaction.isStringSelectMenu() || !interaction.inCachedGuild() || !isAdmin(interaction)) return;
      const path = args[0]!;
      const field = fieldByPath(path);
      const raw = interaction.values[0]!;
      const result = field ? parseFieldValue(field, raw) : { ok: false as const, error: 'Unknown setting.' };
      if (!result.ok) {
        await interaction.reply({ content: result.error, flags: EPHEMERAL });
        return;
      }
      setByPath(interaction.guildId, path, result.value);
      await afterSettingsChange(interaction, path);
      await renderAfterEdit(interaction, path);
      return;
    }

    default:
      log.debug(`Unhandled select ${interaction.customId}`);
  }
}

/** After any edit, drop the member back on the category page with a receipt. */
async function renderAfterEdit(interaction: AnySelectMenuInteraction, path: string): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const field = fieldByPath(path);
  const settings = getSettings(interaction.guildId);

  // The setup screen keeps its own four pickers rather than jumping into the
  // settings tree. We know it by the header this file is the only writer of.
  const onSetupScreen = (interaction.message?.content ?? '').startsWith(SETUP_HEADER);
  if (onSetupScreen) {
    await interaction.update(renderSetup(settings));
    return;
  }

  if (!field) {
    await interaction.update(renderSettingsHome(settings));
    return;
  }
  lastCategory.set(interaction.user.id, field.category);
  await interaction.update(renderCategory(field.category, settings, `Saved **${field.label}**.`));
}

/* ---------------------------------- modals --------------------------------- */

async function onModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parsed = parseId(interaction.customId);
  if (!parsed) return;
  const { action, args } = parsed;

  if (action === 'pick.modal') {
    if (!interaction.inCachedGuild()) return;
    const game = resolveGame(interaction.guildId, args[0]);
    if (!game) {
      await interaction.reply({ content: 'That game is gone. Try again.', flags: EPHEMERAL });
      return;
    }
    const settings = getSettings(interaction.guildId);
    const raw = interaction.fields.getTextInputValue(Ids.customTimeInput);
    const startAt = parseTimeInput(raw, settings.timezone);
    if (!startAt) {
      const note = `Didn't get "${raw}". Try \`9:30pm\`, \`21:30\` or \`in 45\`.`;
      // Put them back on the same step instead of stacking another message.
      if (interaction.isFromMessage()) {
        await interaction.update(renderTimeStep(game, settings, interaction.client, note));
      } else {
        await interaction.reply({ content: note, flags: EPHEMERAL });
      }
      return;
    }
    await startSessionFromInteraction(interaction, game, startAt);
    return;
  }

  if (action === 'games.addm' || action === 'games.editm') {
    if (!interaction.inCachedGuild() || !isAdmin(interaction)) return;

    const name = interaction.fields.getTextInputValue(Ids.gameNameInput).trim();
    const rawEmoji = interaction.fields.getTextInputValue(Ids.gameEmojiInput).trim();

    if (!name) {
      await interaction.reply({ content: 'Needs a name.', flags: EPHEMERAL });
      return;
    }
    if (rawEmoji && !parseEmoji(rawEmoji)) {
      await interaction.reply({
        content: "That emoji didn't parse. Paste the emoji itself, or `<:Name:id>`.",
        flags: EPHEMERAL,
      });
      return;
    }

    const settings = getSettings(interaction.guildId);
    const list = [...settings.games.list];
    const emoji = rawEmoji || '🎮';
    let selectedId: string;
    let note: string;

    if (action === 'games.addm') {
      if (list.length >= 25) {
        await interaction.reply({ content: 'Discord caps the picker at 25 games.', flags: EPHEMERAL });
        return;
      }
      selectedId = makeGameId(name, list.map((game) => game.id));
      list.push({ id: selectedId, name, emoji, enabled: true });
      note = `Added ${emoji} ${name}.`;
    } else {
      selectedId = args[0]!;
      const index = list.findIndex((game) => game.id === selectedId);
      if (index === -1) return;
      // The id stays put so sessions and subscriptions keep matching.
      list[index] = { ...list[index]!, name, emoji };
      note = `Updated ${emoji} ${name}.`;
    }

    const next = setGames(interaction.guildId, list);
    lastCategory.set(interaction.user.id, 'gameList');

    if (interaction.isFromMessage()) {
      await interaction.update(renderGamesHome(next, interaction.client, selectedId, note));
    } else {
      await interaction.reply({
        ...renderGamesHome(next, interaction.client, selectedId, note),
        flags: EPHEMERAL,
      });
    }
    return;
  }

  if (action === 'emoji.set') {
    if (!interaction.inCachedGuild() || !isAdmin(interaction)) return;
    const slot = args[0]!;
    if (!isEmojiSlot(slot)) return;

    const raw = interaction.fields.getTextInputValue(Ids.emojiInput).trim();
    const parsed = parseEmoji(raw);
    if (!parsed) {
      await interaction.reply({
        content: "That emoji didn't parse. Paste the emoji itself, or `<:Name:id>`.",
        flags: EPHEMERAL,
      });
      return;
    }

    const next = setByPath(interaction.guildId, `emojis.${slot}`, parsed.display);
    lastCategory.set(interaction.user.id, 'emojis');

    const reachable = !parsed.id || interaction.client.emojis.cache.has(parsed.id);
    const note = reachable
      ? `Set to ${parsed.display}.`
      : `Saved, but I can't reach ${raw} — I need to be in the server that owns it. Using the backup for now.`;

    if (interaction.isFromMessage()) {
      await interaction.update(renderEmojiHome(next, interaction.client, note));
    } else {
      await interaction.reply({ ...renderEmojiHome(next, interaction.client, note), flags: EPHEMERAL });
    }
    return;
  }

  if (action === 'set.modal') {
    if (!interaction.inCachedGuild() || !isAdmin(interaction)) return;
    const path = args[0]!;
    const field = fieldByPath(path);
    if (!field) return;

    const raw = interaction.fields.getTextInputValue(Ids.settingsInput);
    const result = parseFieldValue(field, raw);
    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.error}`, flags: EPHEMERAL });
      return;
    }

    const settings = setByPath(interaction.guildId, path, result.value);
    await afterSettingsChange(interaction, path);
    lastCategory.set(interaction.user.id, field.category);
    await interaction.reply({
      ...renderCategory(field.category, settings, `${settings.copy.saved} **${field.label}** updated.`),
      flags: EPHEMERAL,
    });
  }
}

/* ------------------------- creating the session itself ---------------------- */

function resolveGame(guildId: string, id: string | undefined): GameEntry | undefined {
  if (!id) return undefined;
  return gameById(getSettings(guildId), id);
}

async function startSessionFromInteraction(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  game: GameEntry,
  startAt: number,
): Promise<void> {
  if (!interaction.inCachedGuild()) return;

  // When the tap came from the ephemeral step message, replace it rather than
  // leaving a trail: the member ends up with exactly one ephemeral, not three.
  const inPlace = interaction.isButton() || interaction.isFromMessage();
  if (inPlace) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: EPHEMERAL });

  const finish = (content: string) =>
    inPlace ? interaction.editReply({ content, components: [] }) : interaction.editReply({ content });

  try {
    const { session, message, channelName } = await createSession({
      guild: interaction.guild,
      organizerId: interaction.user.id,
      game: game.name,
      gameId: game.id,
      startAt,
    });

    void notifySubscribers(interaction.client, interaction.guild, session).catch((error) =>
      log.error('Notifying subscribers failed', error),
    );

    await finish(
      message
        ? `Up in #${channelName}. I'll ping you with the VC when it starts.`
        : `Couldn't post in #${channelName ?? 'that channel'} — check my permissions there.`,
    );
  } catch (error) {
    log.error('Creating a session failed', error);
    await finish(error instanceof Error ? error.message : "Couldn't start that one.");
  }
}

/* --------------------- keeping things in sync after edits ------------------- */

async function afterSettingsChange(
  interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction,
  path: string,
): Promise<void> {
  if (!interaction.inCachedGuild()) return;

  if (path.startsWith('panel.') || path === 'channels.panel' || path === 'features.sessions' || path === 'features.notifications') {
    await postPanel(interaction.guild, path === 'channels.panel');
  }
  if (path.startsWith('weekly.') || path === 'timezone' || path === 'features.clipOfWeek') {
    scheduleWeekly(interaction.guildId);
  }
}
