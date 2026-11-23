import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { openTestDatabase } from '../db/index.js';
import { clearSettingsCache, getSettings, setByPath } from '../db/settings.js';
import { resetConversationState } from '../activity/conversation.js';
import { store, textChannelCounts, voiceChannelCounts } from '../activity/store.js';
import { summarise } from '../activity/summary.js';
import { addMember, advance, botMove, createWorld, joinVoice, leaveVoice, type SimWorld } from './sim/world.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
let world: SimWorld;

const minutesOf = (userId: string) =>
  Math.round(summarise('G', userId, getSettings('G'), world.now).voiceSeconds / 60);

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
  resetConversationState();
  world = createWorld();
  setByPath('G', 'activity.textMode', 'all');
  setByPath('G', 'activity.voiceMode', 'all');
  for (const id of ['ayub', 'abdi', 'ismail']) addMember(world, { id });
  addMember(world, { id: 'musicbot', bot: true });
});

describe('join to create', () => {
  it('loses nothing when a bot moves you into your own channel', () => {
    // Land in the lobby, get moved out a second later — the usual flow.
    joinVoice(world, 'ayub', 'join-to-create');
    advance(world, 1000, 1000);
    botMove(world, 'ayub', 'temp-1', 'VOICE_CAT');
    advance(world, 2 * MINUTE, MINUTE);

    // A friend follows the same path into the same channel.
    joinVoice(world, 'abdi', 'join-to-create');
    advance(world, 1000, 1000);
    botMove(world, 'abdi', 'temp-1', 'VOICE_CAT');
    advance(world, 30 * MINUTE, MINUTE);

    leaveVoice(world, 'ayub');
    leaveVoice(world, 'abdi');

    assert.ok(minutesOf('ayub') >= 29, `expected ~30m together, got ${minutesOf('ayub')}m`);
    assert.ok(minutesOf('abdi') >= 29, `expected ~30m together, got ${minutesOf('abdi')}m`);
  });

  it('counts a freshly created channel when its category is picked', () => {
    setByPath('G', 'activity.voiceMode', 'only');
    setByPath('G', 'activity.voiceChannels', ['VOICE_CAT']);

    botMove(world, 'ayub', 'temp-99', 'VOICE_CAT'); // did not exist a moment ago
    botMove(world, 'abdi', 'temp-99', 'VOICE_CAT');
    advance(world, 20 * MINUTE, MINUTE);
    leaveVoice(world, 'ayub');

    assert.ok(minutesOf('ayub') >= 19, `a new channel under a picked category must count, got ${minutesOf('ayub')}m`);
  });

  it('does not count a channel outside the picked category', () => {
    setByPath('G', 'activity.voiceMode', 'only');
    setByPath('G', 'activity.voiceChannels', ['VOICE_CAT']);

    botMove(world, 'ayub', 'other-1', 'OTHER_CAT');
    botMove(world, 'abdi', 'other-1', 'OTHER_CAT');
    advance(world, 20 * MINUTE, MINUTE);
    leaveVoice(world, 'ayub');

    assert.equal(minutesOf('ayub'), 0);
  });

  it('ignores the lobby itself when it is excluded', () => {
    setByPath('G', 'activity.ignoredChannels', ['join-to-create']);
    joinVoice(world, 'ayub', 'join-to-create');
    joinVoice(world, 'abdi', 'join-to-create');
    advance(world, 10 * MINUTE, MINUTE);
    leaveVoice(world, 'ayub');
    assert.equal(minutesOf('ayub'), 0);
  });
});

describe('being moved around', () => {
  it('banks time for everyone when one person is dragged out', () => {
    joinVoice(world, 'ayub', 'vc1');
    joinVoice(world, 'abdi', 'vc1');
    advance(world, 20 * MINUTE, MINUTE);

    botMove(world, 'ayub', 'vc2'); // moderator or bot moves ayub away
    advance(world, 20 * MINUTE, MINUTE);
    leaveVoice(world, 'abdi');
    leaveVoice(world, 'ayub');

    assert.equal(minutesOf('ayub'), 20, 'ayub keeps the shared 20 minutes');
    assert.equal(minutesOf('abdi'), 20, 'abdi stops earning the moment he is alone');
  });

  it('keeps counting when a pair is moved together', () => {
    joinVoice(world, 'ayub', 'vc1');
    joinVoice(world, 'abdi', 'vc1');
    advance(world, 10 * MINUTE, MINUTE);

    botMove(world, 'ayub', 'vc2');
    botMove(world, 'abdi', 'vc2');
    advance(world, 10 * MINUTE, MINUTE);
    leaveVoice(world, 'ayub');
    leaveVoice(world, 'abdi');

    assert.ok(minutesOf('ayub') >= 19, `moving together should not cost time, got ${minutesOf('ayub')}m`);
  });

  it('stops the clock when Discord moves someone to AFK', () => {
    joinVoice(world, 'ayub', 'vc1');
    joinVoice(world, 'abdi', 'vc1');
    advance(world, 15 * MINUTE, MINUTE);

    botMove(world, 'ayub', 'AFK');
    advance(world, HOUR, 10 * MINUTE);
    leaveVoice(world, 'ayub');
    leaveVoice(world, 'abdi');

    assert.equal(minutesOf('ayub'), 15, 'the AFK hour earns nothing');
  });

  it('handles a whole room emptying at once', () => {
    for (const id of ['ayub', 'abdi', 'ismail']) joinVoice(world, id, 'vc1');
    advance(world, 30 * MINUTE, MINUTE);
    for (const id of ['ayub', 'abdi', 'ismail']) leaveVoice(world, id);

    for (const id of ['ayub', 'abdi']) assert.equal(minutesOf(id), 30, id);
    assert.equal(minutesOf('ismail'), 30);
    assert.equal(store.openVoiceUsers('G').length, 0, 'no sessions left dangling');
  });

  it('never leaves a session open after everyone goes', () => {
    joinVoice(world, 'ayub', 'vc1');
    joinVoice(world, 'abdi', 'vc1');
    advance(world, 5 * MINUTE, MINUTE);
    leaveVoice(world, 'abdi');
    assert.equal(store.openVoiceUsers('G').length, 0, 'the last person alone is closed out too');
  });

  it('treats a bot joining as nobody', () => {
    joinVoice(world, 'ayub', 'vc1');
    joinVoice(world, 'musicbot', 'vc1');
    advance(world, 30 * MINUTE, MINUTE);
    leaveVoice(world, 'ayub');
    assert.equal(minutesOf('ayub'), 0, 'a music bot is not company');
  });

  it('starts counting when a real person joins a bot and a human', () => {
    joinVoice(world, 'ayub', 'vc1');
    joinVoice(world, 'musicbot', 'vc1');
    advance(world, 10 * MINUTE, MINUTE);
    joinVoice(world, 'abdi', 'vc1');
    advance(world, 10 * MINUTE, MINUTE);
    leaveVoice(world, 'ayub');
    assert.ok(minutesOf('ayub') >= 9, `got ${minutesOf('ayub')}m`);
  });

  it('is unaffected by rejoining the same channel', () => {
    joinVoice(world, 'ayub', 'vc1');
    joinVoice(world, 'abdi', 'vc1');
    advance(world, 10 * MINUTE, MINUTE);
    joinVoice(world, 'ayub', 'vc1'); // duplicate event
    advance(world, 10 * MINUTE, MINUTE);
    leaveVoice(world, 'ayub');
    assert.ok(minutesOf('ayub') >= 19, `a repeated join must not reset the clock, got ${minutesOf('ayub')}m`);
  });
});

describe('channel matching', () => {
  const ref = (id: string, parentId: string | null = null) => ({ id, parentId });

  it('matches a category for both text and voice', () => {
    setByPath('G', 'activity.textMode', 'only');
    setByPath('G', 'activity.textChannels', ['CHAT_CAT']);
    setByPath('G', 'activity.voiceMode', 'only');
    setByPath('G', 'activity.voiceChannels', ['VOICE_CAT']);
    const settings = getSettings('G');

    assert.equal(textChannelCounts(settings, ref('any', 'CHAT_CAT'), null), true);
    assert.equal(textChannelCounts(settings, ref('any', 'OTHER'), null), false);
    assert.equal(voiceChannelCounts(settings, ref('temp', 'VOICE_CAT'), 'AFK'), true);
  });

  it('lets an excluded channel override its own category', () => {
    setByPath('G', 'activity.voiceMode', 'only');
    setByPath('G', 'activity.voiceChannels', ['VOICE_CAT']);
    setByPath('G', 'activity.ignoredChannels', ['temp-bad']);
    const settings = getSettings('G');

    assert.equal(voiceChannelCounts(settings, ref('temp-bad', 'VOICE_CAT'), 'AFK'), false);
    assert.equal(voiceChannelCounts(settings, ref('temp-good', 'VOICE_CAT'), 'AFK'), true);
  });

  it('lets an excluded category cover everything inside it', () => {
    setByPath('G', 'activity.voiceMode', 'all');
    setByPath('G', 'activity.ignoredChannels', ['PRIVATE_CAT']);
    assert.equal(voiceChannelCounts(getSettings('G'), ref('secret', 'PRIVATE_CAT'), 'AFK'), false);
  });

  it('counts a thread toward the channel it hangs off', () => {
    setByPath('G', 'activity.textMode', 'only');
    setByPath('G', 'activity.textChannels', ['general']);
    assert.equal(textChannelCounts(getSettings('G'), ref('thread-1', 'general'), null), true);
  });

  it('never counts AFK, whatever the settings say', () => {
    setByPath('G', 'activity.voiceMode', 'all');
    assert.equal(voiceChannelCounts(getSettings('G'), ref('AFK'), 'AFK'), false);
    setByPath('G', 'activity.voiceChannels', ['AFK']);
    setByPath('G', 'activity.voiceMode', 'only');
    assert.equal(voiceChannelCounts(getSettings('G'), ref('AFK'), 'AFK'), false);
  });
});
