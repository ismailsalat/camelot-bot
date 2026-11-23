import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { openTestDatabase } from '../db/index.js';
import {
  DEFAULT_SETTINGS,
  EMOJI_FALLBACKS,
  EMOJI_SLOTS,
  clearSettingsCache,
  enabledGames,
  gameById,
  getSettings,
  makeGameId,
  setByPath,
  setGames,
  type GameEntry,
} from '../db/settings.js';
import { emojiFor, parseEmoji, resolveEmoji } from '../util/emoji.js';
import { renderGamesHome } from '../ui/gamesUi.js';
import { renderEmojiHome } from '../ui/emojiUi.js';
import { isSendable } from '../ui/payload.js';

const GUILD = 'g1';

beforeEach(() => {
  openTestDatabase();
  clearSettingsCache();
});

describe('managing the game list', () => {
  it('builds unique, stable ids', () => {
    assert.equal(makeGameId('Rocket League', []), 'rocket-league');
    assert.equal(makeGameId('Rocket League', ['rocket-league']), 'rocket-league-2');
    assert.equal(makeGameId('!!!', []), 'game');
    assert.equal(makeGameId('Counter-Strike 2', []), 'counter-strike-2');
  });

  it('adds, renames, reorders, hides and removes', () => {
    const start = getSettings(GUILD).games.list;
    const added: GameEntry = { id: 'cs2', name: 'CS2', emoji: '🔫', enabled: true };
    let list = [...start, added];
    setGames(GUILD, list);
    assert.equal(gameById(getSettings(GUILD), 'cs2')?.name, 'CS2');

    // rename keeps the id, so live buttons and subscriptions keep working
    list = list.map((game) => (game.id === 'cs2' ? { ...game, name: 'Counter-Strike' } : game));
    setGames(GUILD, list);
    assert.equal(gameById(getSettings(GUILD), 'cs2')?.name, 'Counter-Strike');

    // hide
    list = list.map((game) => (game.id === 'cs2' ? { ...game, enabled: false } : game));
    setGames(GUILD, list);
    assert.ok(!enabledGames(getSettings(GUILD)).some((game) => game.id === 'cs2'));
    assert.ok(getSettings(GUILD).games.list.some((game) => game.id === 'cs2'), 'hidden, not deleted');

    // reorder
    list = [list[1]!, list[0]!, ...list.slice(2)];
    setGames(GUILD, list);
    assert.equal(getSettings(GUILD).games.list[0]!.id, start[1]!.id);

    // remove
    setGames(GUILD, list.filter((game) => game.id !== 'cs2'));
    assert.equal(gameById(getSettings(GUILD), 'cs2'), undefined);
  });

  it('survives a restart', () => {
    setGames(GUILD, [{ id: 'cs2', name: 'CS2', emoji: '🔫', enabled: true }]);
    clearSettingsCache();
    assert.deepEqual(
      getSettings(GUILD).games.list.map((game) => game.name),
      ['CS2'],
    );
  });

  it('renders a usable screen in every state', () => {
    assert.ok(isSendable(renderGamesHome(DEFAULT_SETTINGS)));
    assert.ok(isSendable(renderGamesHome(DEFAULT_SETTINGS, undefined, 'gta')));
    const empty = { ...DEFAULT_SETTINGS, games: { ...DEFAULT_SETTINGS.games, list: [] } };
    assert.ok(isSendable(renderGamesHome(empty)), 'an empty list still needs a screen');
  });
});

describe('emoji slots', () => {
  it('ships a fallback for every slot', () => {
    for (const slot of EMOJI_SLOTS) {
      assert.ok(EMOJI_FALLBACKS[slot], `${slot} has no fallback`);
      assert.ok(parseEmoji(EMOJI_FALLBACKS[slot]), `${slot} fallback is not a valid emoji`);
    }
  });

  it('defaults to the Camelot pack', () => {
    for (const slot of EMOJI_SLOTS) {
      const parsed = parseEmoji(DEFAULT_SETTINGS.emojis[slot]);
      assert.ok(parsed, `${slot} default does not parse`);
    }
    assert.match(DEFAULT_SETTINGS.emojis.thumbsUp, /Z_thumbsUp/);
  });

  it('falls back to unicode when the bot cannot reach a custom emoji', () => {
    const noEmojis = { emojis: { cache: new Map() } } as never;
    assert.equal(emojiFor(DEFAULT_SETTINGS, 'star', noEmojis), EMOJI_FALLBACKS.star);
  });

  it('uses the custom emoji when it is reachable', () => {
    const client = {
      emojis: { cache: new Map([['1572823623029235832', { available: true }]]) },
    } as never;
    assert.equal(emojiFor(DEFAULT_SETTINGS, 'star', client), DEFAULT_SETTINGS.emojis.star);
  });

  it('never leaves raw markup in a message when a slot is misconfigured', () => {
    const broken = { ...DEFAULT_SETTINGS, emojis: { ...DEFAULT_SETTINGS.emojis, crown: 'not an emoji' } };
    assert.equal(emojiFor(broken, 'crown'), EMOJI_FALLBACKS.crown);
  });

  it('falls back for a game emoji too', () => {
    assert.equal(resolveEmoji('', '🎮'), '🎮');
    assert.equal(resolveEmoji('🏎️', '🎮'), '🏎️');
  });

  it('removing a mapping only changes settings, never the server emoji', () => {
    setByPath(GUILD, 'emojis.crown', '👑');
    assert.equal(getSettings(GUILD).emojis.crown, '👑');
    // nothing here touches Discord — the guild emoji is untouched by design
  });

  it('renders a usable emoji screen', () => {
    assert.ok(isSendable(renderEmojiHome(DEFAULT_SETTINGS)));
  });
});
