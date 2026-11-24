import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { getSettings, highlightsChannelId } from '../db/settings.js';
import { isModuleEnabled, MODULES, moduleBlockedReason } from './registry.js';
import { FULL_COVERAGE_SECONDS, recentDays, store } from '../activity/store.js';
import { canUseEmoji, parseEmoji } from '../util/emoji.js';
import { getToken, hasToken } from '../streaming/store.js';
import { EMOJI_SLOTS } from '../db/settings.js';

/**
 * Plain-language health. Checks are cheap — permissions come from the cache,
 * not the API — so this never hammers Discord, and it runs only when asked.
 */

export type Health = 'ok' | 'warn' | 'off';

export interface Check {
  label: string;
  state: Health;
  /** One short line, only when something needs attention. */
  detail?: string;
}

function channelCheck(
  guild: Guild,
  channelId: string | null,
  label: string,
  needed: { flag: bigint; name: string }[],
): Check {
  if (!channelId) return { label, state: 'warn', detail: 'No channel set yet.' };

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return { label, state: 'warn', detail: 'That channel is gone.' };

  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const missing = needed.filter((entry) => !perms?.has(entry.flag));
  if (missing.length > 0) {
    return {
      label,
      state: 'warn',
      detail: `Camelot needs ${missing.map((entry) => entry.name).join(' and ')} in #${channel.name}.`,
    };
  }
  return { label, state: 'ok', detail: `#${channel.name}` };
}

export function clipsHealth(guild: Guild): Check[] {
  const settings = getSettings(guild.id);
  if (!isModuleEnabled(settings, 'clips')) {
    return [{ label: 'Clips', state: 'off', detail: moduleBlockedReason(settings, 'clips') ?? 'Turned off.' }];
  }

  const checks: Check[] = [
    channelCheck(guild, settings.channels.clips, 'Clips', [
      { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
      { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
      { flag: PermissionFlagsBits.ManageMessages, name: 'Manage Messages' },
      { flag: PermissionFlagsBits.AddReactions, name: 'Add Reactions' },
      { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
    ]),
  ];

  checks.push({
    label: 'Reactions',
    state: settings.modules.clips ? 'ok' : 'off',
    detail: settings.modules.clips ? 'Enabled' : 'Disabled',
  });

  const unreachable = EMOJI_SLOTS.filter((slot) => {
    const parsed = parseEmoji(settings.emojis[slot]);
    return parsed?.id && !canUseEmoji(guild.client, settings.emojis[slot]);
  });
  if (unreachable.length > 0) {
    checks.push({
      label: 'Emojis',
      state: 'warn',
      detail: `${unreachable.length} custom emoji(s) unreachable — using backups.`,
    });
  }

  if (settings.media.bypassModerators) {
    checks.push({
      label: 'Moderator bypass',
      state: 'warn',
      detail: 'Admins can post anything in clips, so your own posts are ignored.',
    });
  }

  const highlights = highlightsChannelId(settings);
  if (highlights && highlights !== settings.channels.clips) {
    checks.push(
      channelCheck(guild, highlights, 'Weekly winner', [
        { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
        { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
      ]),
    );
  }

  return checks;
}

export function activityHealth(guild: Guild): Check[] {
  const settings = getSettings(guild.id);
  if (!isModuleEnabled(settings, 'activity')) {
    return [{ label: 'Activity', state: 'off', detail: moduleBlockedReason(settings, 'activity') ?? 'Turned off.' }];
  }
  if (!settings.activity.enabled) {
    return [{ label: 'Activity', state: 'off', detail: 'Tracking is paused.' }];
  }

  const days = recentDays(30, settings.timezone);
  const coverage = store.coverageFor(guild.id, days);
  const today = days[days.length - 1];
  const observed = days.filter((day) => day !== today && (coverage.get(day) ?? 0) >= FULL_COVERAGE_SECONDS).length;

  const checks: Check[] = [];

  if (observed === 0) {
    checks.push({ label: 'Activity', state: 'warn', detail: "Tracking hasn't collected a full day yet." });
  } else if (observed < settings.purge.minObservedDays) {
    checks.push({
      label: 'Activity',
      state: 'warn',
      detail: `Tracking ${observed} of ${settings.purge.minObservedDays} days needed before review.`,
    });
  } else {
    checks.push({ label: 'Activity', state: 'ok', detail: `Tracking · ${observed} full days recorded` });
  }

  const textChannels =
    settings.activity.textChannels.length > 0
      ? settings.activity.textChannels.map((id) => `<#${id}>`).join(' ')
      : guild.channels.cache.find(
            (channel) => channel.type === ChannelType.GuildText && channel.name.toLowerCase() === 'general',
          )
        ? '#general (default)'
        : null;

  checks.push({
    label: 'Counted channels',
    state: textChannels ? 'ok' : 'warn',
    detail: textChannels ?? 'No text channel set, and there is no #general to fall back on.',
  });

  return checks;
}

export function purgeHealth(guild: Guild): Check[] {
  const settings = getSettings(guild.id);
  if (!isModuleEnabled(settings, 'purge')) {
    return [{ label: 'The Purge', state: 'off', detail: moduleBlockedReason(settings, 'purge') ?? 'Turned off.' }];
  }
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.KickMembers)) {
    return [{ label: 'The Purge', state: 'warn', detail: 'Camelot needs the Kick Members permission.' }];
  }
  const protectedCount = settings.purge.absoluteRoles.length + settings.purge.rolePolicies.length;
  return [
    {
      label: 'The Purge',
      state: 'ok',
      detail: protectedCount > 0 ? `Ready · ${protectedCount} role rule(s)` : 'Ready · no protected roles set',
    },
  ];
}

export function streamingHealth(guild: Guild): Check[] {
  const label = 'Streaming';
  if (!isModuleEnabled(getSettings(guild.id), 'streaming')) return [{label, state:'off', detail:'Turn on in Settings → Modules.'}];
  if (!hasToken(guild.id)) return [{label, state:'warn', detail:'Save the streaming account in Settings → Streaming.'}];
  try { getToken(guild.id); }
  catch { return [{label, state:'warn', detail:'Saved account cannot be opened. Restore the key or save the account again.'}]; }
  return [{label, state:'ok', detail:'Account configured. Join a VC and use /stream to connect.'}];
}

export function overallStatus(guild: Guild): { checks: Check[]; enabledModules: number } {
  const settings = getSettings(guild.id);
  const checks = [...clipsHealth(guild), ...activityHealth(guild), ...purgeHealth(guild), ...streamingHealth(guild)];
  checks.push({ label: 'Database', state: 'ok', detail: 'Connected' });
  const enabledModules = MODULES.filter((module) => isModuleEnabled(settings, module.key)).length;
  return { checks, enabledModules };
}

export function healthGlyph(state: Health): string {
  return state === 'ok' ? 'OK' : state === 'warn' ? 'Needs attention' : 'Off';
}
