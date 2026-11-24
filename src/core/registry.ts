import { PermissionFlagsBits } from 'discord.js';
import type { GuildSettings } from '../db/settings.js';
import type { Tier } from './permissions.js';

/**
 * One description of every module and command. Slash-command registration,
 * `/help`, and the Settings module list all read from here, so adding or
 * removing a command updates all three at once and Help can never drift.
 */

export type ModuleKey = 'core' | 'clips' | 'activity' | 'purge' | 'streaming';

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
  /**
   * Extra names for the same command. Each is registered as its own slash
   * command and accepted as its own prefix command, and all of them route to
   * `name`, so there is still exactly one handler.
   */
  aliases?: string[];
  /** When set, the command takes an optional member to act on. */
  userOption?: { name: string; description: string };
  /**
   * Slash only. A text command answers with a visible message in the channel,
   * which is wrong for anything that shows the server's configuration.
   */
  slashOnly?: boolean;
  /**
   * As a text command, this one needs a member named. The long interactive
   * version stays on the slash command, where the answer is private.
   */
  textNeedsTarget?: boolean;
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
  {key:'streaming',name:'Streaming',blurb:'Watch together. One person holds the controls.',togglable:true,requires:[],permissions:[
    {flag:PermissionFlagsBits.SendMessages,name:'Send Messages'},
    {flag:PermissionFlagsBits.ReadMessageHistory,name:'Read Message History'},
    {flag:PermissionFlagsBits.AttachFiles,name:'Attach Files'},
  ],events:['messageCreate','voiceStateUpdate','interactionCreate'],settingsGroups:['streaming']},
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
  {name:'stream',description:'Open Streaming controls in your voice channel.',module:'streaming',tier:'member',settingsGroup:'streaming'},
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
    // Channel ids, role setup and the rest of the server's wiring. Not
    // something to paste into whatever channel somebody happened to type in.
    slashOnly: true,
  },
  {
    name: 'activity',
    description: 'See who has been around lately.',
    module: 'activity',
    tier: 'member',
    settingsGroup: 'activity',
    aliases: ['allies'],
    userOption: { name: 'user', description: 'Whose activity to show. Leave empty for your own.' },
  },
  {
    name: 'purge',
    description: 'Review members for removal.',
    module: 'purge',
    tier: 'admin',
    defaultPermission: PermissionFlagsBits.KickMembers,
    settingsGroup: 'activity',
    userOption: { name: 'user', description: 'Skip the queue and review one person.' },
    // `!purge @someone` is the shortcut worth having. A whole swipe review
    // playing out in a public channel, scores and all, is not.
    textNeedsTarget: true,
  },
];

/** Every name Discord knows, primary and alias alike. */
export function allCommandNames(): string[] {
  return COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
}

/**
 * Alias to primary. Built once at module load, so routing is a lookup rather
 * than a scan, and an alias can never drift from the command it stands for.
 */
const BY_NAME: Map<string, CommandSpec> = (() => {
  const map = new Map<string, CommandSpec>();
  for (const command of COMMANDS) {
    map.set(command.name, command);
    for (const alias of command.aliases ?? []) map.set(alias, command);
  }
  return map;
})();

export function commandByName(name: string): CommandSpec | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

/** The canonical name for whatever the person typed. */
export function resolveCommand(name: string): string | null {
  return commandByName(name)?.name ?? null;
}

/** "/activity" plus "also /allies" — how Help names a command with aliases. */
export function commandLabel(command: CommandSpec, prefix = '/'): string {
  const names = [command.name, ...(command.aliases ?? [])];
  return names.map((name) => `\`${prefix}${name}\``).join(' · ');
}

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
