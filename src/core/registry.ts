import { PermissionFlagsBits } from 'discord.js';
import type { GuildSettings } from '../db/settings.js';
import type { Tier } from './permissions.js';

/**
 * One description of every module and command. Slash-command registration,
 * `/help`, and the Settings module list all read from here, so adding or
 * removing a command updates all three at once and Help can never drift.
 */

export type ModuleKey = 'core' | 'clips' | 'activity' | 'purge';

export interface CommandSpec {
  name: string;
  /** Shown in Help. Short, plain words. */
  description: string;
  module: ModuleKey;
  /** Lowest tier that can usefully run it. */
  tier: Tier;
  /** Discord-level gate applied at registration. */
  defaultPermission?: bigint;
  /** Where to go in Settings for related options. */
  settingsGroup?: string;
}

export interface ModuleSpec {
  key: ModuleKey;
  name: string;
  /** One line, in Help's voice. */
  blurb: string;
  /** Core can't be switched off. */
  togglable: boolean;
  /** Modules that must be on for this one to work. */
  requires: ModuleKey[];
  /** Discord permissions the module needs to do its job. */
  permissions: { flag: bigint; name: string }[];
  /** Gateway events it listens to — used by Status to explain itself. */
  events: string[];
  settingsGroups: string[];
}

export const MODULES: ModuleSpec[] = [
  {
    key: 'core',
    name: 'Core',
    blurb: 'Help, settings, and the bits everything else sits on.',
    togglable: false,
    requires: [],
    permissions: [
      { flag: PermissionFlagsBits.ViewChannel, name: 'View Channels' },
      { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
    ],
    events: ['interactionCreate'],
    settingsGroups: ['modules', 'permissions', 'emojis', 'status'],
  },
  {
    key: 'clips',
    name: 'Clips',
    blurb: 'Videos and photos get reactions automatically.',
    togglable: true,
    requires: [],
    permissions: [
      { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
      { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
      { flag: PermissionFlagsBits.ManageMessages, name: 'Manage Messages' },
      { flag: PermissionFlagsBits.AddReactions, name: 'Add Reactions' },
      { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
    ],
    events: ['messageCreate', 'messageUpdate', 'messageReactionAdd'],
    settingsGroups: ['channels', 'clips'],
  },
  {
    key: 'activity',
    name: 'Activity',
    blurb: "See who's actually been around.",
    togglable: true,
    requires: [],
    permissions: [{ flag: PermissionFlagsBits.ViewChannel, name: 'View Channels' }],
    events: ['messageCreate', 'voiceStateUpdate'],
    settingsGroups: ['activity', 'channels'],
  },
  {
    key: 'purge',
    name: 'The Purge',
    blurb: 'Review members one at a time. Admin only.',
    togglable: true,
    requires: ['activity'],
    permissions: [{ flag: PermissionFlagsBits.KickMembers, name: 'Kick Members' }],
    events: [],
    // Its controls live under Activity, with protected roles under Permissions.
    settingsGroups: ['activity', 'permissions'],
  },
];

export const COMMANDS: CommandSpec[] = [
  {
    name: 'help',
    description: 'See what Camelot does.',
    module: 'core',
    tier: 'member',
  },
  {
    name: 'settings',
    description: 'Change how Camelot works.',
    module: 'core',
    tier: 'admin',
    defaultPermission: PermissionFlagsBits.ManageGuild,
    settingsGroup: 'modules',
  },
  {
    name: 'activity',
    description: 'See who has been around lately.',
    module: 'activity',
    tier: 'member',
    settingsGroup: 'activity',
  },
  {
    name: 'purge',
    description: 'Review members for removal.',
    module: 'purge',
    tier: 'admin',
    defaultPermission: PermissionFlagsBits.KickMembers,
    settingsGroup: 'activity',
  },
];

export function moduleByKey(key: ModuleKey): ModuleSpec {
  return MODULES.find((module) => module.key === key)!;
}

export function commandsFor(module: ModuleKey): CommandSpec[] {
  return COMMANDS.filter((command) => command.module === module);
}

/** Core is always on; everything else follows settings. */
export function isModuleEnabled(settings: GuildSettings, key: ModuleKey): boolean {
  if (key === 'core') return true;
  const own = settings.modules[key];
  if (!own) return false;
  // A module whose dependency is off cannot do its job.
  return moduleByKey(key).requires.every((dependency) => isModuleEnabled(settings, dependency));
}

/** Why a module isn't working, in one line, or null when it is. */
export function moduleBlockedReason(settings: GuildSettings, key: ModuleKey): string | null {
  if (key === 'core') return null;
  if (!settings.modules[key]) return 'Turned off.';
  const missing = moduleByKey(key).requires.filter((dependency) => !isModuleEnabled(settings, dependency));
  if (missing.length > 0) {
    return `Needs ${missing.map((dependency) => moduleByKey(dependency).name).join(' and ')}.`;
  }
  return null;
}

const TIER_ORDER: Record<Tier, number> = { member: 0, admin: 1, owner: 2 };

export function tierAllows(actual: Tier, required: Tier): boolean {
  return TIER_ORDER[actual] >= TIER_ORDER[required];
}

/** Commands a given person can actually use right now. */
export function visibleCommands(settings: GuildSettings, tier: Tier): CommandSpec[] {
  return COMMANDS.filter(
    (command) => isModuleEnabled(settings, command.module) && tierAllows(tier, command.tier),
  );
}
