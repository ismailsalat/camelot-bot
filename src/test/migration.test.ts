import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { migrateSettingsRow, v1VoteEmojis } from '../db/migrate002.js';
import { DEFAULT_SETTINGS, mergeDefaults, type GuildSettings } from '../db/settings.js';

/** What v1 wrote: the whole object, defaults frozen in place. */
const V1_FULL_SAVE = JSON.stringify({
  timezone: 'America/Los_Angeles',
  features: { sessions: true, mediaOnly: true, voting: true, clipOfWeek: true, notifications: true },
  channels: { panel: '111', sessions: null, clips: '222', highlights: null },
  panel: {
    title: "Who's down?",
    body: 'Start a game, get friends together, and join a voice channel automatically.',
    startLabel: 'Start a Game',
    notifyLabel: 'Notifications',
    messageId: '999',
  },
  games: {
    options: ['Marvel Rivals', 'GTA', 'Valorant', 'Fortnite', 'Other'],
    quickOffsets: [0, 15, 30],
    allowCustomTime: true,
    durationMinutes: 180,
    deleteOnClose: false,
  },
  voice: { eligible: ['v1', 'v2'], excluded: [], allowShared: false, requireCapacity: true },
  media: { bypassModerators: true, warning: { deleteAfterSeconds: 5, cooldownSeconds: 20 } },
  voting: { up: '👍', down: '👎', exclusive: true, countAuthorVote: false, downvotesSubtract: false },
  weekly: { dayOfWeek: 5, time: '20:00', title: 'Clip of the Week', minVotes: 1, announceNoWinner: false },
});

function migrated(raw: string): GuildSettings {
  return mergeDefaults(DEFAULT_SETTINGS, JSON.parse(migrateSettingsRow(raw)));
}

describe('migrating a v1 server', () => {
  it('keeps everything the admin actually chose', () => {
    const settings = migrated(V1_FULL_SAVE);
    assert.equal(settings.channels.panel, '111');
    assert.equal(settings.channels.clips, '222');
    assert.deepEqual(settings.voice.eligible, ['v1', 'v2']);
    assert.equal(settings.panel.messageId, '999', 'the pinned panel is still found after a restart');
  });

  it('releases values that only matched an old default', () => {
    const stored = JSON.parse(migrateSettingsRow(V1_FULL_SAVE));
    assert.equal(stored.media?.bypassModerators, undefined, 'never explicitly chosen, so not frozen');

    // ...which means the improved default now reaches this server.
    assert.equal(migrated(V1_FULL_SAVE).media.bypassModerators, false);
  });

  it('respects a value the admin deliberately changed', () => {
    const raw = JSON.stringify({ media: { bypassModerators: false, graceMs: 9000 } });
    const settings = migrated(raw);
    assert.equal(settings.media.graceMs, 9000);
  });

  it('turns a customised game list into entries with stable ids', () => {
    const raw = JSON.stringify({ games: { options: ['Marvel Rivals', 'Deep Rock Galactic'] } });
    const settings = migrated(raw);
    assert.deepEqual(
      settings.games.list.map((game) => game.id),
      ['marvel-rivals', 'deep-rock-galact'],
    );
    assert.equal(settings.games.list[0]!.name, 'Marvel Rivals');
    assert.equal(settings.games.list[0]!.enabled, true);
    assert.ok(settings.games.list[0]!.emoji.length > 0, 'every game gets a fallback emoji');
  });

  it('a default game list simply becomes the new default list', () => {
    const settings = migrated(V1_FULL_SAVE);
    assert.deepEqual(
      settings.games.list.map((game) => game.id),
      DEFAULT_SETTINGS.games.list.map((game) => game.id),
    );
  });

  it('default ids match the slug used to backfill existing rows', () => {
    // sessions.game_id and game_subscriptions.game are migrated in SQL with
    // lower(replace(name,' ','-')) — the ids here have to agree with that.
    for (const game of DEFAULT_SETTINGS.games.list) {
      assert.equal(game.id, game.name.toLowerCase().replaceAll(' ', '-'), game.name);
    }
  });

  it('keeps a custom game list and gives each entry a unique id', () => {
    const raw = JSON.stringify({ games: { options: ['Rocket League', 'Rocket League', 'CS2'] } });
    const ids = migrated(raw).games.list.map((game) => game.id);
    assert.deepEqual(ids, ['rocket-league', 'rocket-league-2', 'cs2']);
    assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  });

  it('moves custom vote emojis onto the new emoji slots', () => {
    const raw = JSON.stringify({ voting: { up: '<:pog:123456789012345678>', down: '💀' } });
    const settings = migrated(raw);
    assert.equal(settings.emojis.thumbsUp, '<:pog:123456789012345678>');
    assert.equal(settings.emojis.thumbsDown, '💀');
  });

  it('leaves default vote emojis alone so the new pack applies', () => {
    const settings = migrated(V1_FULL_SAVE);
    assert.equal(settings.emojis.thumbsUp, DEFAULT_SETTINGS.emojis.thumbsUp);
  });

  it('survives junk without throwing', () => {
    assert.equal(migrateSettingsRow('not json'), '{}');
    assert.equal(migrateSettingsRow('[]'), '{}');
    assert.equal(migrateSettingsRow('{}'), '{}');
  });

  it('is safe to run twice', () => {
    const once = migrateSettingsRow(V1_FULL_SAVE);
    const twice = migrateSettingsRow(once);
    assert.deepEqual(JSON.parse(twice), JSON.parse(once));
  });
});

describe('votes already cast survive the emoji change', () => {
  it('reads the vote emojis a v1 server was using', () => {
    assert.deepEqual(v1VoteEmojis(V1_FULL_SAVE), { up: '👍', down: '👎' });
    assert.deepEqual(v1VoteEmojis(JSON.stringify({ voting: { up: '🔥', down: '💀' } })), {
      up: '🔥',
      down: '💀',
    });
    assert.deepEqual(v1VoteEmojis('garbage'), { up: '👍', down: '👎' }, 'falls back, never throws');
  });
});
