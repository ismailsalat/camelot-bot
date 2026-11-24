import { PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { getSettings } from '../db/settings.js';

/**
 * Three tiers, checked server-side every time. The UI hides what you can't do,
 * but hiding is never the control — every handler re-checks.
 */
export type Tier = 'member' | 'admin' | 'owner';

export function tierOf(member: GuildMember): Tier {
  if (member.id === member.guild.ownerId) return 'owner';

  const settings = getSettings(member.guild.id);
  if (settings.permissions.adminRoles.some((roleId) => member.roles.cache.has(roleId))) return 'admin';
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return 'admin';
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return 'admin';
  return 'member';
}

export function isOwner(member: GuildMember): boolean {
  return tierOf(member) === 'owner';
}

export function isAdmin(member: GuildMember): boolean {
  const tier = tierOf(member);
  return tier === 'admin' || tier === 'owner';
}

/**
 * Settings groups are owner-only unless the owner has delegated them.
 * Admins can never grant themselves owner-level reach: `permissions` is not
 * delegatable, so the list of admin roles stays the owner's alone.
 */
export const OWNER_ONLY_GROUPS = ['permissions', 'modules'] as const;

export function canEditGroup(member: GuildMember, group: string): boolean {
  const tier = tierOf(member);
  if (tier === 'owner') return true;
  if (tier !== 'admin') return false;
  if (group === 'streaming') return true;
  if ((OWNER_ONLY_GROUPS as readonly string[]).includes(group)) return false;
  return getSettings(member.guild.id).permissions.adminEditable.includes(group);
}

/** Groups the owner is allowed to hand to admins. */
export const DELEGATABLE_GROUPS = ['channels', 'clips', 'activity', 'emojis', 'streaming', 'status'] as const;

export function describeTier(tier: Tier): string {
  if (tier === 'owner') return 'Server owner';
  if (tier === 'admin') return 'Admin';
  return 'Member';
}

/** Can Camelot actually kick this person? Checks hierarchy and permissions. */
export function canBotKick(guild: Guild, target: GuildMember): { ok: true } | { ok: false; reason: string } {
  const me = guild.members.me;
  if (!me) return { ok: false, reason: 'I am not in this server properly.' };
  if (!me.permissions.has(PermissionFlagsBits.KickMembers)) {
    return { ok: false, reason: 'I need the Kick Members permission.' };
  }
  if (target.id === guild.ownerId) return { ok: false, reason: 'That is the server owner.' };
  if (!target.kickable) return { ok: false, reason: 'Their role is above mine.' };
  return { ok: true };
}
