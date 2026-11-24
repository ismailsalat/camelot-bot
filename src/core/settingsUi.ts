import {
  ActionRowBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type GuildMember,
} from 'discord.js';
import {
  EMOJI_LABELS,
  EMOJI_SLOTS,
  getByPath,
  getSettings,
  type EmojiSlot,
  type GuildSettings,
} from '../db/settings.js';
import { button, container, divider, heading, row, selectRow, text, ACCENT_MUTED } from './ui.js';
import { settingsCard } from '../streaming/ui.js';
import { Ids } from './ids.js';
import { groupLabel } from './help.js';
import { canEditGroup, DELEGATABLE_GROUPS, tierOf } from './permissions.js';
import { prefixFor } from './prefix.js';
import { MODULES, isModuleEnabled, moduleBlockedReason, moduleByKey } from './registry.js';
import { componentEmojiFor, emojiFor, parseEmoji } from '../util/emoji.js';
import { healthGlyph, overallStatus } from './status.js';

/**
 * One settings application. Every screen is the same shape: a heading, the
 * current values, native pickers, and a Back button.
 */

export const GROUPS = ['modules', 'channels', 'activity', 'clips', 'permissions', 'emojis', 'streaming', 'status'] as const;
export type Group = (typeof GROUPS)[number];

const GROUP_BLURBS: Record<Group, string> = {
  streaming: 'Streaming account and playback',
  modules: 'Turn parts of Camelot on and off',
  channels: 'Where Camelot watches and posts',
  activity: 'How activity is counted',
  clips: 'Media rules and the weekly winner',
  permissions: 'Who can change what',
  emojis: 'Swap in your server emojis',
  status: 'Check setup and permissions',
};

export function renderHome(member: GuildMember) {
  const settings = getSettings(member.guild.id);
  const tier = tierOf(member);

  const options = GROUPS.filter((group) => canEditGroup(member, group) || group === 'status').map((group) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(groupLabel(group))
      .setValue(group)
      .setDescription(GROUP_BLURBS[group]),
  );

  const body = container()
    .addTextDisplayComponents(heading(`${emojiFor(settings, 'crown', undefined)}  CAMELOT SETTINGS`))
    .addSeparatorComponents(divider());

  const enabled = MODULES.filter((module) => isModuleEnabled(settings, module.key)).map((module) => module.name);
  body.addTextDisplayComponents(text(`On right now: ${enabled.join(' · ')}`));
  if(!settings.modules.streaming)body.addTextDisplayComponents(text('Streaming is off. Enable it in Modules, then set up the account in Streaming.'));

  if (tier === 'admin') {
    body.addTextDisplayComponents(text('_Some settings are owner only._'));
  }

  body.addActionRowComponents(
    selectRow(
      new StringSelectMenuBuilder()
        .setCustomId(Ids.settingsPick('home'))
        .setPlaceholder('Pick a category')
        .addOptions(options),
    ),
  );

  return body;
}

function backRow() {
  return row(button(Ids.settingsHome(), 'Back', ButtonStyle.Secondary));
}

/* --------------------------------- modules --------------------------------- */

function renderModules(member: GuildMember) {
  const settings = getSettings(member.guild.id);
  const body = container()
    .addTextDisplayComponents(heading('MODULES', 'Core always stays on.'))
    .addSeparatorComponents(divider());

  for (const module of MODULES) {
    const on = isModuleEnabled(settings, module.key);
    const blocked = moduleBlockedReason(settings, module.key);
    const state = module.key === 'core' ? 'Always on' : on ? 'On' : 'Off';
    const needs =
      module.requires.length > 0
        ? ` · needs ${module.requires.map((key) => moduleByKey(key).name).join(' and ')}`
        : '';
    body.addTextDisplayComponents(
      text(`**${module.name}** — ${state}${needs}\n${module.blurb}${blocked && !on ? `\n_${blocked}_` : ''}`),
    );
  }

  const toggles = MODULES.filter((module) => module.togglable).map((module) =>
    button(
      Ids.settingsModule(module.key),
      `${settings.modules[module.key as 'clips' | 'activity' | 'purge' | 'streaming'] ? 'Turn off' : 'Turn on'} ${module.name}`,
      settings.modules[module.key as 'clips' | 'activity' | 'purge' | 'streaming'] ? ButtonStyle.Secondary : ButtonStyle.Success,
    ),
  );

  // Text commands live here rather than in their own category: one line and
  // one button does not justify a whole screen.
  const prefix = prefixFor(member.guild.id);
  const own = settings.core.prefix;
  body
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        `**Text commands** — ${settings.core.textCommands ? 'On' : 'Off'}\n` +
          `Text shortcuts: \`${prefix}allies\`, \`${prefix}purge @someone\`. Streaming uses \`/stream\` or \`!stream\`; its fallback stays available when text commands are off.\n` +
          `Prefix: \`${prefix}\`${own ? '' : ' _(from the host settings)_'}`,
      ),
    );

  body
    .addSeparatorComponents(divider())
    .addActionRowComponents(row(...toggles))
    .addActionRowComponents(
      row(
        button(
          Ids.settingsToggle('core.textCommands'),
          settings.core.textCommands ? 'Turn off text commands' : 'Turn on text commands',
          settings.core.textCommands ? ButtonStyle.Secondary : ButtonStyle.Success,
        ),
        button(Ids.settingsText('core.prefix'), 'Change prefix', ButtonStyle.Secondary),
      ),
    )
    .addActionRowComponents(backRow());
  return body;
}

/** Owner only: the one free-text setting, so it validates on the way in. */
export function buildPrefixModal(settings: GuildSettings, guildId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(Ids.settingsText('core.prefix'))
    .setTitle('Text command prefix')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(Ids.settingsInput)
          .setLabel('1-3 symbols, or blank for the default')
          .setPlaceholder('!')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(3)
          .setValue(settings.core.prefix ?? prefixFor(guildId)),
      ),
    );
}

/* --------------------------------- channels -------------------------------- */

function channelPicker(
  path: string,
  placeholder: string,
  settings: GuildSettings,
  types: ChannelType[],
  max: number,
) {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(Ids.settingsChannels(path))
    .setPlaceholder(placeholder)
    .setChannelTypes(...types)
    .setMinValues(0)
    .setMaxValues(max);

  const value = getByPath(settings, path);
  if (typeof value === 'string') select.setDefaultChannels(value);
  else if (Array.isArray(value) && value.length > 0) select.setDefaultChannels(...(value as string[]));

  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
}

function renderChannels(member: GuildMember) {
  const settings = getSettings(member.guild.id);
  // Three mentions then a count — a long list turns the screen into noise.
  const list = (ids: string[] | string | null, fallback: string): string => {
    if (typeof ids === 'string') return `<#${ids}>`;
    if (!Array.isArray(ids) || ids.length === 0) return fallback;
    const shown = ids.slice(0, 3).map((id) => `<#${id}>`).join(' ');
    return ids.length > 3 ? `${shown} *+${ids.length - 3} more*` : shown;
  };

  const textAll = settings.activity.textMode === 'all';
  const voiceAll = settings.activity.voiceMode === 'all';

  return container()
    .addTextDisplayComponents(heading('CHANNELS', 'Where Camelot watches and posts.'))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(`📎 **Clips** ${list(settings.channels.clips, '*not set*')}`))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        [
          '💬 **Text activity**',
          textAll
            ? `Counting **every channel**, minus anything excluded.`
            : `Counting **only** ${list(settings.activity.textChannels, '*#general*')}`,
          '',
          '🔊 **Voice activity**',
          voiceAll
            ? `Counting **every voice channel**, minus AFK and anything excluded.`
            : `Counting **only** ${list(settings.activity.voiceChannels, '*nothing yet*')}`,
          '',
          `🚫 **Never counted** ${list(settings.activity.ignoredChannels, '*nothing*')}`,
          '',
          '_Pick a category to cover everything inside it, including voice channels made later._',
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      row(
        button(
          Ids.settingsMode('activity.textMode'),
          textAll ? 'Text: all channels' : 'Text: only picked',
          textAll ? ButtonStyle.Primary : ButtonStyle.Secondary,
        ),
        button(
          Ids.settingsMode('activity.voiceMode'),
          voiceAll ? 'Voice: all channels' : 'Voice: only picked',
          voiceAll ? ButtonStyle.Primary : ButtonStyle.Secondary,
        ),
      ),
    )
    .addActionRowComponents(channelPicker('channels.clips', 'Clips channel', settings, [ChannelType.GuildText], 1))
    .addActionRowComponents(
      channelPicker(
        'activity.textChannels',
        textAll ? 'Text channels (unused in "all" mode)' : 'Text channels or a whole category',
        settings,
        [ChannelType.GuildText, ChannelType.GuildCategory],
        20,
      ),
    )
    .addActionRowComponents(
      channelPicker(
        'activity.voiceChannels',
        voiceAll ? 'Voice channels (unused in "all" mode)' : 'Voice channels or a whole category',
        settings,
        [ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory],
        20,
      ),
    )
    .addActionRowComponents(
      channelPicker(
        'activity.ignoredChannels',
        'Never count these (wins in both modes)',
        settings,
        [
          ChannelType.GuildText,
          ChannelType.GuildVoice,
          ChannelType.GuildStageVoice,
          ChannelType.GuildCategory,
        ],
        20,
      ),
    );
}

/* --------------------------------- activity -------------------------------- */

interface NumberField {
  path: string;
  label: string;
  suffix: string;
  min: number;
  max: number;
}

export const ACTIVITY_NUMBERS: NumberField[] = [
  { path: 'activity.dailyMessageCap', label: 'Messages counted per day', suffix: '', min: 1, max: 200 },
  { path: 'activity.messageCooldownSeconds', label: 'Seconds between counted messages', suffix: 's', min: 0, max: 3600 },
  { path: 'activity.activeDayMessages', label: 'Messages for an active day', suffix: '', min: 1, max: 100 },
  { path: 'activity.activeDayVoiceMinutes', label: 'Voice minutes for an active day', suffix: 'm', min: 1, max: 600 },
  { path: 'activity.dailyVoiceCapMinutes', label: 'Voice minutes counted per day', suffix: 'm', min: 10, max: 1440 },
  { path: 'activity.gracePeriodDays', label: 'New member grace period', suffix: 'd', min: 0, max: 180 },
  { path: 'activity.retentionDays', label: 'Keep daily history for', suffix: 'd', min: 30, max: 730 },
];

export const PURGE_NUMBERS: NumberField[] = [
  { path: 'purge.inactivityDays', label: 'Quiet days before review', suffix: 'd', min: 1, max: 365 },
  { path: 'purge.minObservedDays', label: 'Tracked days needed first', suffix: 'd', min: 1, max: 90 },
];

export function numberFieldByPath(path: string): NumberField | undefined {
  return [...ACTIVITY_NUMBERS, ...PURGE_NUMBERS].find((field) => field.path === path);
}

function renderActivity(member: GuildMember) {
  const settings = getSettings(member.guild.id);
  const body = container()
    .addTextDisplayComponents(
      heading('ACTIVITY', 'Counters only. No message text, no audio, ever.'),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        [
          `**Tracking** ${settings.activity.enabled ? 'On' : 'Paused'}`,
          ...ACTIVITY_NUMBERS.map(
            (field) => `**${field.label}** ${String(getByPath(settings, field.path))}${field.suffix}`,
          ),
          '',
          '**The Purge**',
          ...PURGE_NUMBERS.map(
            (field) => `**${field.label}** ${String(getByPath(settings, field.path))}${field.suffix}`,
          ),
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      row(
        button(
          Ids.settingsToggle('activity.enabled'),
          settings.activity.enabled ? 'Pause tracking' : 'Start tracking',
          settings.activity.enabled ? ButtonStyle.Secondary : ButtonStyle.Success,
        ),
        button(Ids.settingsWipe(), 'Clear all activity data', ButtonStyle.Danger),
      ),
    )
    .addActionRowComponents(
      selectRow(
        new StringSelectMenuBuilder()
          .setCustomId(Ids.settingsPick('activity'))
          .setPlaceholder('Change a number')
          .addOptions(
            [...ACTIVITY_NUMBERS, ...PURGE_NUMBERS].map((field) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(field.label)
                .setValue(field.path)
                .setDescription(`Now: ${String(getByPath(settings, field.path))}${field.suffix}`),
            ),
          ),
      ),
    )
    .addActionRowComponents(backRow());

  return body;
}

/* ---------------------------------- clips ---------------------------------- */

function renderClips(member: GuildMember) {
  const settings = getSettings(member.guild.id);
  const checks = overallStatus(member.guild).checks.filter((check) =>
    ['Clips', 'Reactions', 'Emojis', 'Moderator bypass', 'Weekly winner'].includes(check.label),
  );

  const body = container()
    .addTextDisplayComponents(heading('CLIPS', 'Media gets reactions automatically.'))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(checks.map((check) => `**${check.label}** ${healthGlyph(check.state)}${check.detail ? ` · ${check.detail}` : ''}`).join('\n')),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        [
          `**Delete text-only posts** ${settings.modules.clips ? 'On' : 'Off'}`,
          `**Warning** ${settings.media.warning.mode} · deletes after ${settings.media.warning.deleteAfterSeconds}s`,
          `**Ping the author** ${settings.media.warning.pingAuthor ? 'Yes' : 'No'}`,
          `**Admins bypass** ${settings.media.bypassModerators ? 'Yes' : 'No'}`,
          `**Weekly winner** ${settings.weekly.title} · day ${settings.weekly.dayOfWeek} at ${settings.weekly.time}`,
        ].join('\n'),
      ),
    )
    .addActionRowComponents(
      row(
        button(
          Ids.settingsToggle('media.warning.pingAuthor'),
          settings.media.warning.pingAuthor ? 'Stop pinging' : 'Ping the author',
        ),
        button(
          Ids.settingsToggle('media.bypassModerators'),
          settings.media.bypassModerators ? 'Apply to admins too' : 'Let admins bypass',
        ),
        button(
          Ids.settingsToggle('voting.downvotesSubtract'),
          settings.voting.downvotesSubtract ? 'Ignore downvotes' : 'Downvotes subtract',
        ),
      ),
    )
    .addActionRowComponents(backRow());

  return body;
}

/* ------------------------------- permissions ------------------------------- */

function renderPermissions(member: GuildMember) {
  const settings = getSettings(member.guild.id);
  const body = container()
    .addTextDisplayComponents(heading('PERMISSIONS', 'Owner decides what admins can touch.'))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        [
          '**Members** — Help and their own activity.',
          '**Admins** — the groups you allow below.',
          '**You** — everything, including this screen.',
          '',
          `**Admin roles** ${settings.permissions.adminRoles.length > 0 ? settings.permissions.adminRoles.map((id) => `<@&${id}>`).join(' ') : '*Manage Server permission only*'}`,
          `**Admins may change** ${settings.permissions.adminEditable.map(groupLabel).join(', ') || '*nothing*'}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text('**Protected roles** — these members can never be purged.'))
    .addTextDisplayComponents(
      text(
        `${settings.purge.absoluteRoles.length > 0 ? settings.purge.absoluteRoles.map((id) => `<@&${id}>`).join(' ') : '*none set*'}`,
      ),
    );

  const adminRoles = new RoleSelectMenuBuilder()
    .setCustomId(Ids.settingsRoles('permissions.adminRoles'))
    .setPlaceholder('Admin roles')
    .setMinValues(0)
    .setMaxValues(10);
  if (settings.permissions.adminRoles.length > 0) adminRoles.setDefaultRoles(...settings.permissions.adminRoles);

  const protectedRoles = new RoleSelectMenuBuilder()
    .setCustomId(Ids.settingsRoles('purge.absoluteRoles'))
    .setPlaceholder('Protected roles — never purged')
    .setMinValues(0)
    .setMaxValues(10);
  if (settings.purge.absoluteRoles.length > 0) protectedRoles.setDefaultRoles(...settings.purge.absoluteRoles);

  body
    .addActionRowComponents(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(adminRoles))
    .addActionRowComponents(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(protectedRoles))
    .addActionRowComponents(
      selectRow(
        new StringSelectMenuBuilder()
          .setCustomId(Ids.settingsPick('delegate'))
          .setPlaceholder('What admins may change')
          .setMinValues(0)
          .setMaxValues(DELEGATABLE_GROUPS.length)
          .addOptions(
            DELEGATABLE_GROUPS.map((group) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(groupLabel(group))
                .setValue(group)
                .setDefault(settings.permissions.adminEditable.includes(group)),
            ),
          ),
      ),
    )
    .addActionRowComponents(backRow());

  return body;
}

/* ---------------------------------- emojis --------------------------------- */

function renderEmojis(member: GuildMember, client?: Client) {
  const settings = getSettings(member.guild.id);
  const lines = EMOJI_SLOTS.map((slot) => {
    const shown = emojiFor(settings, slot, client);
    const parsed = parseEmoji(settings.emojis[slot]);
    const unreachable = parsed?.id && client && !client.emojis.cache.has(parsed.id);
    return `${shown} ${EMOJI_LABELS[slot]}${unreachable ? ' · *using backup*' : ''}`;
  });

  return container()
    .addTextDisplayComponents(heading('EMOJIS', 'Used across every screen.'))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(lines.join('\n')))
    .addActionRowComponents(
      selectRow(
        new StringSelectMenuBuilder()
          .setCustomId(Ids.settingsPick('emoji'))
          .setPlaceholder('Change one')
          .addOptions(
            EMOJI_SLOTS.map((slot) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(EMOJI_LABELS[slot].split(' — ')[0] ?? slot)
                .setValue(slot)
                .setDescription(EMOJI_LABELS[slot].split(' — ')[1]?.slice(0, 100) ?? ''),
            ),
          ),
      ),
    )
    .addActionRowComponents(backRow());
}

/* ---------------------------------- status --------------------------------- */

function renderStatus(member: GuildMember) {
  const { checks, enabledModules } = overallStatus(member.guild);
  const problems = checks.filter((check) => check.state === 'warn');

  const body = container(problems.length > 0 ? 0x8b6d2a : undefined)
    .addTextDisplayComponents(heading('CAMELOT STATUS'))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        checks
          .map((check) => `**${check.label}** ${healthGlyph(check.state)}${check.detail ? `\n${check.detail}` : ''}`)
          .join('\n'),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(`Modules: ${enabledModules} enabled`))
    .addActionRowComponents(backRow());

  return body;
}

/* --------------------------------- dispatch -------------------------------- */

export function renderGroup(member: GuildMember, group: Group, client?: Client) {
  switch (group) {
    case 'streaming':
      return settingsCard(member);
    case 'modules':
      return renderModules(member);
    case 'channels':
      return renderChannels(member);
    case 'activity':
      return renderActivity(member);
    case 'clips':
      return renderClips(member);
    case 'permissions':
      return renderPermissions(member);
    case 'emojis':
      return renderEmojis(member, client);
    default:
      return renderStatus(member);
  }
}

export function buildNumberModal(field: NumberField, settings: GuildSettings): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(Ids.settingsNumber(field.path))
    .setTitle(field.label.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(Ids.settingsInput)
          .setLabel(`Between ${field.min} and ${field.max}`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(6)
          .setValue(String(getByPath(settings, field.path) ?? '')),
      ),
    );
}

export function buildEmojiModal(slot: EmojiSlot, settings: GuildSettings): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(Ids.settingsEmoji(slot))
    .setTitle((EMOJI_LABELS[slot].split(' — ')[0] ?? slot).slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(Ids.settingsInput)
          .setLabel('Emoji')
          .setPlaceholder('Paste the emoji, or <:Name:id>')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(60)
          .setValue(settings.emojis[slot]),
      ),
    );
}

export function wipeConfirm() {
  return container(ACCENT_MUTED)
    .addTextDisplayComponents(heading('CLEAR ACTIVITY DATA', 'Every counter and daily summary. Cannot be undone.'))
    .addTextDisplayComponents(text('Settings, clips and roles are untouched.'))
    .addActionRowComponents(
      row(
        button(Ids.settingsWipeConfirm(), 'Clear it', ButtonStyle.Danger),
        button(Ids.settingsGroup('activity'), 'Keep it', ButtonStyle.Secondary),
      ),
    );
}
