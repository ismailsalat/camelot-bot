import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { getDb, openTestDatabase } from '../db/index.js';
import {
  DEFAULT_SETTINGS,
  clearSettingsCache,
  diffFromDefaults,
  getByPath,
  getSettings,
  highlightsChannelId,
  mergeDefaults,
  setByPath,
} from '../db/settings.js';
import { ACTIVITY_NUMBERS, PURGE_NUMBERS, numberFieldByPath } from '../core/settingsUi.js';

const GUILD = 'g1';

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
});

describe('settings storage', () => {
  it('ships the documented defaults', () => {
    const settings = getSettings(GUILD);
    assert.equal(settings.activity.dailyMessageCap, 12);
    assert.equal(settings.activity.activeDayVoiceMinutes, 15);
    assert.equal(settings.activity.activeDayMessages, 5);
    assert.equal(settings.activity.dailyVoiceCapMinutes, 180);
    assert.equal(settings.activity.gracePeriodDays, 30);
    assert.equal(settings.purge.inactivityDays, 21);
    assert.equal(settings.purge.minObservedDays, 21);
    assert.equal(settings.timezone, 'America/Los_Angeles');
  });

  it('persists a change across a restart', () => {
    setByPath(GUILD, 'activity.dailyMessageCap', 20);
    clearSettingsCache();
    assert.equal(getSettings(GUILD).activity.dailyMessageCap, 20);
  });

  it('keeps servers apart', () => {
    setByPath(GUILD, 'purge.inactivityDays', 45);
    assert.equal(getSettings('other').purge.inactivityDays, 21);
  });

  it('stores only what changed, so better defaults still land', () => {
    setByPath(GUILD, 'purge.inactivityDays', 45);
    const raw = (getDb().prepare(`SELECT data FROM guild_settings WHERE guild_id = ?`).get(GUILD) as {
      data: string;
    }).data;
    assert.deepEqual(JSON.parse(raw), { purge: { inactivityDays: 45 } });
  });

  it('drops settings that no longer exist', () => {
    // A database written by the previous version still has the game panel keys.
    const stale = { games: { list: [] }, panel: { messageId: 'x' }, voice: { eligible: ['a'] }, timezone: 'UTC' };
    const merged = mergeDefaults(DEFAULT_SETTINGS, stale) as unknown as Record<string, unknown>;
    assert.equal(merged.games, undefined);
    assert.equal(merged.panel, undefined);
    assert.equal(merged.voice, undefined);
    assert.equal(merged.timezone, 'UTC', 'real settings still come through');
  });

  it('keeps the clips configuration the old version saved', () => {
    const stored = {
      channels: { clips: 'CH', highlights: null, panel: 'GONE' },
      emojis: { thumbsUp: '<:Z_thumbsUp:1>' },
      media: { providers: ['custom.example'] },
    };
    const merged = mergeDefaults(DEFAULT_SETTINGS, stored);
    assert.equal(merged.channels.clips, 'CH');
    assert.equal(merged.emojis.thumbsUp, '<:Z_thumbsUp:1>');
    assert.deepEqual(merged.media.providers, ['custom.example']);
    assert.equal(merged.emojis.thumbsDown, DEFAULT_SETTINGS.emojis.thumbsDown, 'untouched slots keep defaults');
  });

  it('falls back from highlights to clips', () => {
    setByPath(GUILD, 'channels.clips', 'C');
    assert.equal(highlightsChannelId(getSettings(GUILD)), 'C');
    setByPath(GUILD, 'channels.highlights', 'H');
    assert.equal(highlightsChannelId(getSettings(GUILD)), 'H');
  });

  it('diffs nested objects without losing siblings', () => {
    const diff = diffFromDefaults(
      { ...DEFAULT_SETTINGS, activity: { ...DEFAULT_SETTINGS.activity, dailyMessageCap: 1 } },
      DEFAULT_SETTINGS,
    );
    assert.deepEqual(diff, { activity: { dailyMessageCap: 1 } });
  });
});

describe('editable number fields', () => {
  it('points at real settings with sane bounds', () => {
    for (const field of [...ACTIVITY_NUMBERS, ...PURGE_NUMBERS]) {
      const value = getByPath(DEFAULT_SETTINGS, field.path);
      assert.equal(typeof value, 'number', `${field.path} is not a number`);
      assert.ok(field.min < field.max, field.path);
      assert.ok(
        (value as number) >= field.min && (value as number) <= field.max,
        `${field.path} default ${value} is outside ${field.min}-${field.max}`,
      );
      assert.ok(field.label.length <= 45, `${field.path} label too long for a modal title`);
    }
  });

  it('can look a field up by path', () => {
    assert.equal(numberFieldByPath('purge.inactivityDays')?.label, 'Quiet days before review');
    assert.equal(numberFieldByPath('nope.nothing'), undefined);
  });
});
