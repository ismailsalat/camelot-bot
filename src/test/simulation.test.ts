import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { openTestDatabase } from '../db/index.js';
import { clearSettingsCache, getSettings, setByPath } from '../db/settings.js';
import { resetConversationState } from '../activity/conversation.js';
import { dayKey, recentDays, store, textChannelCounts, voiceChannelCounts } from '../activity/store.js';
import { summarise } from '../activity/summary.js';
import {
  addMember,
  advance,
  crash,
  coverWholeDay,
  createWorld,
  joinVoice,
  leaveVoice,
  restart,
  say,
  type SimWorld,
} from './sim/world.js';

const HOUR = 3600_000;
const MINUTE = 60_000;

const ref = (id: string, parentId: string | null = null) => ({ id, parentId });

let world: SimWorld;

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
  resetConversationState();
  world = createWorld();
  setByPath('G', 'activity.textMode', 'all');
  setByPath('G', 'activity.voiceMode', 'all');
  for (const id of ['ayub', 'abdi', 'ismail', 'burn']) addMember(world, { id });
  addMember(world, { id: 'botty', bot: true });
});

describe('a real conversation counts, spam does not', () => {
  it('counts a fast back-and-forth between people', () => {
    // A proper argument: short gaps, but several voices.
    let counted = 0;
    const lines = [
      ['ayub', 'i think the trade was terrible honestly'],
      ['abdi', 'nah it was fine, they needed a guard'],
      ['ayub', 'a guard who cannot shoot though'],
      ['ismail', 'he shot 38 percent last season'],
      ['abdi', 'exactly, and the defence matters more'],
      ['ayub', 'defence does not win you a playoff series'],
    ] as const;
    for (const [who, line] of lines) {
      if (say(world, who, line).counted) counted += 1;
      advance(world, 12_000, 12_000); // twelve seconds apart
    }
    assert.equal(counted, 6, 'every turn in a debate should count');
  });

  it('ignores one person flooding the channel alone', () => {
    let counted = 0;
    for (let i = 0; i < 20; i += 1) {
      if (say(world, 'ayub', `message number ${i} with some padding text`).counted) counted += 1;
      advance(world, 10_000, 10_000);
    }
    assert.ok(counted <= 3, `a solo flood should barely count, got ${counted}`);
  });

  it('ignores the same message sent again', () => {
    assert.equal(say(world, 'ayub', 'hello everyone').counted, true);
    advance(world, 2 * MINUTE, MINUTE);
    const repeat = say(world, 'ayub', 'hello everyone');
    assert.equal(repeat.counted, false);
    assert.equal(repeat.reason, 'duplicate');
  });

  it('ignores one-word filler', () => {
    const short = say(world, 'ayub', 'k');
    assert.equal(short.counted, false);
    assert.equal(short.reason, 'too-short');
  });

  it('stops a monologue even when the messages are long', () => {
    const reasons: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const result = say(world, 'ayub', `a genuinely different sentence number ${i} about basketball`);
      if (!result.counted && result.reason) reasons.push(result.reason);
      advance(world, 90_000, 90_000); // past the solo cooldown every time
    }
    assert.ok(reasons.includes('monologue'), `expected a monologue cut-off, saw ${reasons.join(',')}`);
  });

  it('lets the same person resume once others join in', () => {
    for (let i = 0; i < 8; i += 1) {
      say(world, 'ayub', `solo thought ${i} padded out a bit`);
      advance(world, 60_000, 60_000);
    }
    say(world, 'abdi', 'actually I disagree with all of that');
    advance(world, 10_000, 10_000);
    const resumed = say(world, 'ayub', 'alright but hear me out on this one');
    assert.equal(resumed.counted, true, 'a reply in a live conversation counts again');
  });

  it('holds the daily cap', () => {
    let counted = 0;
    for (let i = 0; i < 60; i += 1) {
      // Alternate speakers so the conversation rules stay happy.
      if (say(world, 'ayub', `point ${i} in an ongoing debate`).counted) counted += 1;
      say(world, 'abdi', `counterpoint ${i} right back at you`);
      advance(world, 20_000, 20_000);
    }
    assert.equal(counted, getSettings('G').activity.dailyMessageCap);
  });
});

describe('voice time', () => {
  it('earns nothing sitting alone', () => {
    joinVoice(world, 'ayub', 'general');
    advance(world, 2 * HOUR);
    leaveVoice(world, 'ayub');

    const summary = summarise('G', 'ayub', getSettings('G'), world.now);
    assert.equal(summary.voiceSeconds, 0, 'alone is not activity');
  });

  it('earns nothing sitting with only a bot', () => {
    joinVoice(world, 'ayub', 'general');
    joinVoice(world, 'botty', 'general');
    advance(world, 2 * HOUR);
    leaveVoice(world, 'ayub');

    assert.equal(summarise('G', 'ayub', getSettings('G'), world.now).voiceSeconds, 0);
  });

  it('starts the clock for both people when the second arrives', () => {
    joinVoice(world, 'ayub', 'general');
    advance(world, 30 * MINUTE); // alone, earns nothing
    joinVoice(world, 'abdi', 'general');
    advance(world, HOUR); // together
    leaveVoice(world, 'abdi');
    advance(world, 30 * MINUTE); // alone again
    leaveVoice(world, 'ayub');

    const settings = getSettings('G');
    const ayub = summarise('G', 'ayub', settings, world.now);
    const abdi = summarise('G', 'abdi', settings, world.now);
    assert.equal(Math.round(ayub.voiceSeconds / 60), 60, 'only the shared hour');
    assert.equal(Math.round(abdi.voiceSeconds / 60), 60);
  });

  it('keeps counting while a third person comes and goes', () => {
    joinVoice(world, 'ayub', 'general');
    joinVoice(world, 'abdi', 'general');
    advance(world, 30 * MINUTE);
    joinVoice(world, 'ismail', 'general');
    advance(world, 30 * MINUTE);
    leaveVoice(world, 'ismail');
    advance(world, 30 * MINUTE);
    leaveVoice(world, 'abdi');
    leaveVoice(world, 'ayub');

    const ayub = summarise('G', 'ayub', getSettings('G'), world.now);
    assert.equal(Math.round(ayub.voiceSeconds / 60), 90, 'the whole 90 minutes stayed eligible');
  });

  it('ignores the AFK channel', () => {
    joinVoice(world, 'ayub', 'AFK');
    joinVoice(world, 'abdi', 'AFK');
    advance(world, 2 * HOUR);
    leaveVoice(world, 'ayub');
    assert.equal(summarise('G', 'ayub', getSettings('G'), world.now).voiceSeconds, 0);
  });

  it('follows people when they move channels', () => {
    joinVoice(world, 'ayub', 'general');
    joinVoice(world, 'abdi', 'general');
    advance(world, 30 * MINUTE);
    joinVoice(world, 'ayub', 'gaming');
    joinVoice(world, 'abdi', 'gaming');
    advance(world, 30 * MINUTE);
    leaveVoice(world, 'ayub');
    leaveVoice(world, 'abdi');

    assert.equal(Math.round(summarise('G', 'ayub', getSettings('G'), world.now).voiceSeconds / 60), 60);
  });

  it('splits a session that runs past midnight', () => {
    // Start at 23:00 local and run four hours.
    world.now = Date.UTC(2026, 9, 2, 7, 0, 0); // 2026-10-02 00:00 PDT
    world.now -= HOUR; // 23:00 on the 1st
    joinVoice(world, 'ayub', 'general');
    joinVoice(world, 'abdi', 'general');
    advance(world, 4 * HOUR);
    leaveVoice(world, 'ayub');

    const first = store.dailyFor('G', 'ayub', ['2026-10-01']).get('2026-10-01');
    const second = store.dailyFor('G', 'ayub', ['2026-10-02']).get('2026-10-02');
    assert.ok(first && second, 'both days should have time');
    assert.equal(Math.round((first!.voice_seconds + second!.voice_seconds) / 60), 240);
    assert.ok(Math.abs(first!.voice_seconds / 60 - 60) <= 1, 'about an hour on the first day');
  });

  it('invents no hours when the bot crashes mid-session', () => {
    joinVoice(world, 'ayub', 'general');
    joinVoice(world, 'abdi', 'general');
    advance(world, HOUR);

    crash(world);
    advance(world, 6 * HOUR); // offline, nothing observed
    restart(world);
    advance(world, HOUR);
    leaveVoice(world, 'ayub');

    const summary = summarise('G', 'ayub', getSettings('G'), world.now);
    const hours = summary.voiceSeconds / 3600;
    assert.ok(hours <= 1.05, `must not credit downtime, got ${hours.toFixed(2)}h`);
    assert.ok(hours >= 0.9, `should keep the hour after the restart, got ${hours.toFixed(2)}h`);
  });

  it('shows real time but scores only the daily cap', () => {
    joinVoice(world, 'ayub', 'general');
    joinVoice(world, 'abdi', 'general');
    advance(world, 8 * HOUR);
    leaveVoice(world, 'ayub');

    const summary = summarise('G', 'ayub', getSettings('G'), world.now);
    assert.equal(Math.round(summary.voiceSeconds / 3600), 8, 'tells the truth about the time');
    assert.equal(Math.round(summary.scoredVoiceSeconds / 3600), 3, 'but only scores three hours');
  });
});

describe('an outage is not the same as being quiet', () => {
  it('marks unobserved days as untracked, not idle', () => {
    const days = recentDays(30, world.timezone, world.now);
    for (const day of days.slice(0, 10)) coverWholeDay(world, day);
    // The middle ten days: the bot was down entirely.
    for (const day of days.slice(20, 29)) coverWholeDay(world, day);

    const summary = summarise('G', 'ayub', getSettings('G'), world.now);
    const untracked = summary.timeline.filter((state) => state === 'unknown').length;
    assert.ok(untracked >= 10, `the gap should read as untracked, got ${untracked}`);
    assert.ok(summary.observedDays < 30);
  });

  it('will not call someone inactive on a short history', () => {
    const days = recentDays(30, world.timezone, world.now);
    for (const day of days.slice(-5)) coverWholeDay(world, day);
    const summary = summarise('G', 'ayub', getSettings('G'), world.now);
    assert.equal(summary.provisional, true, 'five days is not enough to judge anyone');
  });
});

describe('a month in the life of a server', () => {
  it('ranks regulars above lurkers, and says so honestly', () => {
    const days = recentDays(30, world.timezone, world.now);
    for (const day of days) coverWholeDay(world, day);

    // Wind back a month and play it forward.
    world.now -= 29 * 86_400_000;

    for (let day = 0; day < 29; day += 1) {
      // ayub: in voice with abdi most evenings, chatty
      if (day % 2 === 0) {
        joinVoice(world, 'ayub', 'general');
        joinVoice(world, 'abdi', 'general');
        advance(world, 2 * HOUR);
        leaveVoice(world, 'ayub');
        leaveVoice(world, 'abdi');
        for (let i = 0; i < 6; i += 1) {
          say(world, 'ayub', `thoughts on the game tonight part ${day}-${i}`);
          say(world, 'abdi', `replying properly to that point ${day}-${i}`);
          advance(world, 30_000, 30_000);
        }
      }
      // ismail: shows up once a week
      if (day % 7 === 0) {
        joinVoice(world, 'ismail', 'gaming');
        joinVoice(world, 'ayub', 'gaming');
        advance(world, 40 * MINUTE);
        leaveVoice(world, 'ismail');
        leaveVoice(world, 'ayub');
      }
      // burn: never does anything
      advance(world, 20 * HOUR);
      resetConversationState(); // a new day, conversation state rolls over
    }

    const settings = getSettings('G');
    const ayub = summarise('G', 'ayub', settings, world.now);
    const ismail = summarise('G', 'ismail', settings, world.now);
    const burn = summarise('G', 'burn', settings, world.now);

    assert.ok(ayub.score > ismail.score, `regular ${ayub.score} should beat occasional ${ismail.score}`);
    assert.ok(ismail.score > burn.score, `occasional ${ismail.score} should beat absent ${burn.score}`);
    assert.equal(burn.score, 0);
    assert.equal(burn.daysSinceActive, null, 'never active is not "0 days ago"');

    assert.ok(ayub.activeDays >= 10, `expected a regular to rack up days, got ${ayub.activeDays}`);
    assert.ok(ayub.inactivityPercent < 20, `a regular should not read as likely inactive (${ayub.inactivityPercent}%)`);
    assert.ok(burn.inactivityPercent > 60, `someone with nothing recorded should read high (${burn.inactivityPercent}%)`);
  });
});

describe('channel modes', () => {
  it('counts everything except exclusions in "all" mode', () => {
    setByPath('G', 'activity.textMode', 'all');
    setByPath('G', 'activity.ignoredChannels', ['spam']);
    assert.equal(say(world, 'ayub', 'a message in a random channel', 'random').counted, true);
    advance(world, 2 * MINUTE, MINUTE);
    assert.equal(say(world, 'ayub', 'a message in the spam channel', 'spam').counted, true, 'judge allows it');
    const today = dayKey(world.now, world.timezone);
    assert.equal(store.dailyFor('G', 'ayub', [today]).get(today)?.messages, 2, 'the tracker filters, not the judge');
  });

  it('counts only the listed channels in "only" mode', () => {
    setByPath('G', 'activity.textMode', 'only');
    setByPath('G', 'activity.textChannels', ['general']);
    const settings = getSettings('G');
    assert.equal(textChannelCounts(settings, ref('general'), null), true);
    assert.equal(textChannelCounts(settings, ref('random'), null), false);
  });

  it('lets exclusions win in either mode', () => {
    setByPath('G', 'activity.textMode', 'only');
    setByPath('G', 'activity.textChannels', ['general']);
    setByPath('G', 'activity.ignoredChannels', ['general']);
    assert.equal(textChannelCounts(getSettings('G'), ref('general'), null), false);

    setByPath('G', 'activity.voiceMode', 'all');
    assert.equal(voiceChannelCounts(getSettings('G'), ref('AFK'), 'AFK'), false, 'AFK never counts');
  });
});

describe('voice counts even when the member cache is cold', () => {
  it('counts two people in a channel regardless of what is cached', () => {
    // The simulation keys off user ids, the same way the tracker now does.
    joinVoice(world, 'ayub', 'vc6');
    joinVoice(world, 'abdi', 'vc6');
    advance(world, 4 * MINUTE, MINUTE);
    leaveVoice(world, 'ayub');

    const summary = summarise('G', 'ayub', getSettings('G'), world.now);
    assert.ok(summary.voiceSeconds >= 3 * 60, `four minutes should register, got ${summary.voiceSeconds}s`);
  });

  it('still earns nothing for one person sitting alone', () => {
    joinVoice(world, 'ayub', 'vc6');
    advance(world, 30 * MINUTE);
    leaveVoice(world, 'ayub');
    assert.equal(summarise('G', 'ayub', getSettings('G'), world.now).voiceSeconds, 0);
  });

  it('starts counting the moment a second person walks in', () => {
    joinVoice(world, 'ayub', 'vc6');
    advance(world, 10 * MINUTE);
    assert.equal(store.hasOpenVoice('G', 'ayub'), false, 'alone, no session is open');

    joinVoice(world, 'abdi', 'vc6');
    assert.equal(store.hasOpenVoice('G', 'ayub'), true, 'the clock starts for the person already there');
    advance(world, 5 * MINUTE, MINUTE);
    leaveVoice(world, 'abdi');

    const summary = summarise('G', 'ayub', getSettings('G'), world.now);
    assert.ok(summary.voiceSeconds >= 4 * 60 && summary.voiceSeconds <= 6 * 60, `got ${summary.voiceSeconds}s`);
  });
});
