import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { EMOJI_SLOTS, enabledGames, highlightsChannelId, sessionsChannelId, type GuildSettings } from '../db/settings.js';
import { canUseEmoji, parseEmoji } from '../util/emoji.js';

export interface Finding {
  level: 'blocked' | 'heads-up';
  text: string;
}

function channelIssues(
  guild: Guild,
  channelId: string | null,
  label: string,
  needed: { flag: bigint; name: string }[],
): Finding[] {
  if (!channelId) return [{ level: 'blocked', text: `No ${label} channel set — run \`/camelot setup\`.` }];

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return [{ level: 'blocked', text: `The ${label} channel is gone. Pick a new one.` }];

  const me = guild.members.me;
  if (!me) return [];
  const perms = channel.permissionsFor(me);

  const missing = needed.filter((entry) => !perms?.has(entry.flag)).map((entry) => entry.name);
  if (missing.length === 0) return [];
  return [{ level: 'blocked', text: `I need **${missing.join('**, **')}** in <#${channelId}>.` }];
}

/**
 * What an admin needs to know, in plain words. This is what turns a silent
 * "it just doesn't work" into something fixable in one click.
 */
export function diagnose(guild: Guild, settings: GuildSettings): Finding[] {
  const findings: Finding[] = [];
  const view = { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' };
  const send = { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' };

  if (settings.features.sessions) {
    findings.push(...channelIssues(guild, settings.channels.panel, 'games panel', [view, send]));
    const panelId = settings.channels.panel;
    if (panelId) {
      const channel = guild.channels.cache.get(panelId);
      const perms = guild.members.me ? channel?.permissionsFor(guild.members.me) : undefined;
      if (perms && !perms.has(PermissionFlagsBits.ManageMessages)) {
        findings.push({ level: 'heads-up', text: `I can post the panel in <#${panelId}> but not pin it.` });
      }
    }
    if (sessionsChannelId(settings) !== settings.channels.panel) {
      findings.push(...channelIssues(guild, sessionsChannelId(settings), 'session posts', [view, send]));
    }

    const voice = [...guild.channels.cache.values()].filter(
      (channel) => channel.type === ChannelType.GuildVoice && channel.id !== guild.afkChannelId,
    );
    const pool = settings.voice.eligible.length > 0
      ? voice.filter((channel) => settings.voice.eligible.includes(channel.id))
      : voice;
    if (pool.length === 0) {
      findings.push({ level: 'blocked', text: 'No voice channels I can pick from. Add some under Voice channels.' });
    }

    if (enabledGames(settings).length === 0) {
      findings.push({ level: 'blocked', text: 'No games are visible. Add one under Games.' });
    }
  }

  if (settings.features.mediaOnly || settings.features.voting) {
    findings.push(
      ...channelIssues(guild, settings.channels.clips, 'clips', [
        view,
        send,
        { flag: PermissionFlagsBits.ManageMessages, name: 'Manage Messages' },
        { flag: PermissionFlagsBits.AddReactions, name: 'Add Reactions' },
        { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
      ]),
    );

    // The quiet gotcha: an admin testing in their own server is exempt.
    if (settings.media.bypassModerators) {
      findings.push({
        level: 'heads-up',
        text: 'Moderators bypass the media rule — your own posts in clips are ignored. Turn it off under **Clips: the warning** to test.',
      });
    }
    if (settings.media.bypassRoles.length > 0) {
      findings.push({
        level: 'heads-up',
        text: `These roles can post anything in clips: ${settings.media.bypassRoles.map((id) => `<@&${id}>`).join(' ')}`,
      });
    }
  }

  if (settings.features.clipOfWeek) {
    findings.push(...channelIssues(guild, highlightsChannelId(settings), 'weekly winner', [view, send]));
  }

  const unreachable = EMOJI_SLOTS.filter((slot) => {
    const configured = settings.emojis[slot];
    const parsed = parseEmoji(configured);
    return parsed?.id && !canUseEmoji(guild.client, configured);
  });
  if (unreachable.length > 0) {
    findings.push({
      level: 'heads-up',
      text: `${unreachable.length} custom emoji(s) aren't reachable, so I'm using the backups. Check them under **Emojis**.`,
    });
  }

  return findings;
}
