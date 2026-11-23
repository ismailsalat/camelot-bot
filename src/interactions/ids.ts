/**
 * Custom IDs are "cam:<action>:<arg>:<arg>". Keeping them in one place makes
 * the router exhaustive and keeps us inside Discord's 100-character limit.
 */

export const NS = 'cam';

export function makeId(action: string, ...args: (string | number)[]): string {
  const id = [NS, action, ...args.map((arg) => encodeURIComponent(String(arg)))].join(':');
  if (id.length > 100) throw new Error(`custom_id too long: ${id}`);
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
  panelStart: () => makeId('panel.start'),
  panelNotify: () => makeId('panel.notify'),

  pickGame: () => makeId('pick.game'),
  pickTime: (game: string, minutes: number) => makeId('pick.time', game, minutes),
  pickCustom: (game: string) => makeId('pick.custom', game),
  customTimeModal: (game: string) => makeId('pick.modal', game),
  customTimeInput: 'time',

  sessionJoin: (sessionId: number) => makeId('sess.join', sessionId),
  sessionRetryVc: (sessionId: number) => makeId('sess.vc', sessionId),
  sessionCancel: (sessionId: number) => makeId('sess.cancel', sessionId),

  notifyGames: () => makeId('notify.games'),
  notifyMute: () => makeId('notify.mute'),

  setupChannel: (key: string) => makeId('setup.channel', key),
  setupVoice: () => makeId('setup.voice'),
  setupDone: () => makeId('setup.done'),

  settingsCategory: () => makeId('set.cat'),
  settingsField: (category: string) => makeId('set.field', category),
  settingsToggle: (path: string) => makeId('set.toggle', path),
  settingsModal: (path: string) => makeId('set.modal', path),
  settingsChannel: (path: string) => makeId('set.chan', path),
  settingsRoles: (path: string) => makeId('set.roles', path),
  settingsChoice: (path: string) => makeId('set.choice', path),
  settingsInput: 'value',
  settingsBack: () => makeId('set.back'),

  // Games management
  gamesHome: () => makeId('games.home'),
  gamesPick: () => makeId('games.pick'),
  gamesAdd: () => makeId('games.add'),
  gamesAddModal: () => makeId('games.addm'),
  gamesEditModal: (id: string) => makeId('games.editm', id),
  gamesToggle: (id: string) => makeId('games.toggle', id),
  gamesDelete: (id: string) => makeId('games.del', id),
  gamesUp: (id: string) => makeId('games.up', id),
  gamesDown: (id: string) => makeId('games.down', id),
  gameNameInput: 'name',
  gameEmojiInput: 'emoji',

  // Emoji management
  emojiPick: () => makeId('emoji.pick'),
  emojiModal: (slot: string) => makeId('emoji.set', slot),
  emojiReset: () => makeId('emoji.reset'),
  emojiInput: 'emoji',
} as const;
