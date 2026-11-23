/** Custom ids are "c:<action>:<arg>…". Short on purpose: Discord caps them at 100. */
export const NS = 'c';

export function makeId(action: string, ...args: (string | number)[]): string {
  const id = [NS, action, ...args.map((arg) => encodeURIComponent(String(arg)))].join(':');
  if (id.length > 100) throw new Error(`custom_id too long (${id.length}): ${action}`);
  return id;
}

export interface ParsedId {
  action: string;
  args: string[];
}

export function parseId(customId: string): ParsedId | null {
  if (!customId.startsWith(`${NS}:`)) return null;
  const [, action, ...args] = customId.split(':');
  if (!action) return null;
  return { action, args: args.map((arg) => decodeURIComponent(arg)) };
}

export const Ids = {
  helpCategory: () => makeId('h.cat'),
  helpHome: () => makeId('h.home'),

  settingsHome: () => makeId('s.home'),
  settingsGroup: (group: string) => makeId('s.g', group),
  settingsToggle: (path: string) => makeId('s.t', path),
  settingsMode: (path: string) => makeId('s.mode', path),
  settingsModule: (key: string) => makeId('s.m', key),
  settingsChannels: (path: string) => makeId('s.ch', path),
  settingsRoles: (path: string) => makeId('s.r', path),
  settingsNumber: (path: string) => makeId('s.n', path),
  settingsText: (path: string) => makeId('s.x', path),
  settingsPick: (group: string) => makeId('s.p', group),
  settingsEmoji: (slot: string) => makeId('s.e', slot),
  settingsWipe: () => makeId('s.wipe'),
  settingsWipeConfirm: () => makeId('s.wipe2'),
  settingsInput: 'v',

  activityHome: () => makeId('a.home'),
  activityMine: () => makeId('a.me'),
  activityRefresh: (userId: string) => makeId('a.rf', userId),
  activityPickMember: () => makeId('a.pick'),
  activityView: (userId: string) => makeId('a.v', userId),
  activityBoard: (page: number) => makeId('a.lb', page),
  activityAway: (userId: string) => makeId('a.away', userId),
  activityAwaySet: (userId: string, days: number) => makeId('a.away2', userId, days),
  activityAwayClear: (userId: string) => makeId('a.away0', userId),

  purgeStart: (scope: string) => makeId('p.go1', scope),
  purgeScope: () => makeId('p.scope'),
  purgeDecide: (decision: string) => makeId('p.d', decision),
  purgeBack: () => makeId('p.back'),
  purgeFinish: () => makeId('p.fin'),
  purgeList: () => makeId('p.list'),
  purgeResume: () => makeId('p.res'),
  purgeConfirm: () => makeId('p.ok'),
  purgeExecute: () => makeId('p.go'),
  purgeCancel: () => makeId('p.no'),
  purgeConfirmInput: 'count',
} as const;
