import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type VoiceChannel,
} from 'discord.js';
import type { GuildSettings } from '../db/settings.js';
import { sessions } from '../db/repos.js';
import { log } from '../logger.js';

/* ---------------------------------------------------------------------------
 * The selection rules live in `choose()`, which is pure and unit-tested.
 * `pickVoiceChannel()` just gathers the facts from Discord and calls it.
 * ------------------------------------------------------------------------- */

export interface VcOption {
  id: string;
  name: string;
  /** 0 means no limit. */
  userLimit: number;
  occupancy: number;
  isAfk: boolean;
  botCanView: boolean;
  /** Attendees who cannot see or connect to this channel. */
  blockedUserIds: string[];
  /** Position in the admin's priority list; unlisted channels sort last. */
  priority: number;
  /** Another live session already claimed it. */
  reserved: boolean;
}

export interface ChooseInput {
  options: VcOption[];
  attendeeCount: number;
  allowShared: boolean;
  requireCapacity: boolean;
}

export interface ChooseResult {
  channelId: string | null;
  /** Short, human-readable explanation — stored on the session for admins. */
  reason: string;
}

function capacityFits(option: VcOption, attendees: number, requireCapacity: boolean): boolean {
  if (!requireCapacity || option.userLimit === 0) return true;
  return option.userLimit - option.occupancy >= attendees;
}

export function choose(input: ChooseInput): ChooseResult {
  const { options, attendeeCount, allowShared, requireCapacity } = input;
  if (options.length === 0) return { channelId: null, reason: 'no eligible voice channels are configured' };

  const rejected: string[] = [];
  const eligible = options.filter((option) => {
    if (option.isAfk) return false;
    if (!option.botCanView) return false;
    if (option.reserved) return false;
    if (option.blockedUserIds.length > 0) {
      rejected.push(`${option.name} (${option.blockedUserIds.length} can't join)`);
      return false;
    }
    if (!capacityFits(option, attendeeCount, requireCapacity)) {
      rejected.push(`${option.name} (not enough room)`);
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    const detail = rejected.length > 0 ? `: ${rejected.slice(0, 3).join(', ')}` : '';
    return { channelId: null, reason: `no voice channel fits everyone${detail}` };
  }

  const byPreference = (a: VcOption, b: VcOption): number =>
    a.occupancy - b.occupancy || a.priority - b.priority || a.name.localeCompare(b.name);

  const empty = eligible.filter((option) => option.occupancy === 0).sort(byPreference);
  if (empty.length > 0) {
    const winner = empty[0]!;
    return { channelId: winner.id, reason: `empty channel "${winner.name}"` };
  }

  if (!allowShared) {
    return { channelId: null, reason: 'every eligible channel is in use and sharing is turned off' };
  }

  const shared = eligible.sort(byPreference)[0]!;
  return {
    channelId: shared.id,
    reason: `sharing "${shared.name}" (${shared.occupancy} already there)`,
  };
}

/* ----------------------------- Discord gathering ---------------------------- */

export async function pickVoiceChannel(
  guild: Guild,
  settings: GuildSettings,
  attendeeIds: string[],
  forSessionId?: number,
): Promise<ChooseResult & { channel: VoiceChannel | null }> {
  const me = guild.members.me;
  if (!me) return { channelId: null, channel: null, reason: 'bot member not available' };

  const configured = settings.voice.eligible;
  const excluded = new Set(settings.voice.excluded);
  const afkId = guild.afkChannelId;

  // Reserved: a VC already assigned to another session that has not closed.
  const reserved = new Set(
    sessions
      .active(guild.id)
      .filter((row) => row.id !== forSessionId && row.vc_channel_id)
      .map((row) => row.vc_channel_id!),
  );

  const all = [...guild.channels.cache.values()].filter(
    (channel): channel is VoiceChannel => channel.type === ChannelType.GuildVoice,
  );
  const pool = configured.length > 0 ? all.filter((channel) => configured.includes(channel.id)) : all;

  // Resolve attendees once; a member who left the server simply drops out.
  const members: GuildMember[] = [];
  for (const id of attendeeIds) {
    const cached = guild.members.cache.get(id);
    if (cached) {
      members.push(cached);
      continue;
    }
    try {
      members.push(await guild.members.fetch(id));
    } catch {
      log.debug(`Attendee ${id} is no longer in ${guild.id}`);
    }
  }

  // Count occupancy straight from voice states so it stays correct whether or
  // not the Server Members intent is on.
  const occupancyOf = (channelId: string): number =>
    guild.voiceStates.cache.filter((state) => state.channelId === channelId).size;

  const options: VcOption[] = pool
    .filter((channel) => !excluded.has(channel.id))
    .map((channel) => {
      const botPerms = channel.permissionsFor(me);
      const blockedUserIds = members
        .filter((member) => {
          const perms = channel.permissionsFor(member);
          return !perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect);
        })
        .map((member) => member.id);

      const priorityIndex = settings.voice.eligible.indexOf(channel.id);

      return {
        id: channel.id,
        name: channel.name,
        userLimit: channel.userLimit,
        occupancy: occupancyOf(channel.id),
        isAfk: channel.id === afkId,
        botCanView: !!botPerms?.has(PermissionFlagsBits.ViewChannel),
        blockedUserIds,
        priority: priorityIndex === -1 ? Number.MAX_SAFE_INTEGER : priorityIndex,
        reserved: reserved.has(channel.id),
      } satisfies VcOption;
    });

  const result = choose({
    options,
    attendeeCount: Math.max(1, members.length),
    allowShared: settings.voice.allowShared,
    requireCapacity: settings.voice.requireCapacity,
  });

  const channel = result.channelId ? (guild.channels.cache.get(result.channelId) as VoiceChannel | undefined) : undefined;
  return { ...result, channel: channel ?? null };
}
