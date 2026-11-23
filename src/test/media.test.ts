import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyUrl, extractUrls, inspect, type MediaRules } from '../features/mediaDetect.js';
import { DEFAULT_SETTINGS } from '../db/settings.js';

const rules: MediaRules = {
  allowImages: DEFAULT_SETTINGS.media.allowImages,
  allowVideos: DEFAULT_SETTINGS.media.allowVideos,
  allowAudio: DEFAULT_SETTINGS.media.allowAudio,
  allowStickers: DEFAULT_SETTINGS.media.allowStickers,
  providers: DEFAULT_SETTINGS.media.providers,
  blockedProviders: DEFAULT_SETTINGS.media.blockedProviders,
};

const base = { content: '', attachments: [], embeds: [], stickerCount: 0 };

describe('media detection', () => {
  it('accepts a video attachment with a caption (acceptance test 1)', () => {
    const verdict = inspect(
      { ...base, content: 'bro look at this 😂', attachments: [{ contentType: 'video/mp4', name: 'clip.mp4' }] },
      rules,
    );
    assert.equal(verdict.kind, 'media');
  });

  it('accepts images, GIFs and stickers (acceptance test 2)', () => {
    assert.equal(inspect({ ...base, attachments: [{ contentType: 'image/png', name: 'a.png' }] }, rules).kind, 'media');
    assert.equal(inspect({ ...base, attachments: [{ contentType: null, name: 'a.gif' }] }, rules).kind, 'media');
    assert.equal(inspect({ ...base, stickerCount: 1 }, rules).kind, 'media');
  });

  it('accepts supported short-video links and direct media links', () => {
    for (const url of [
      'https://www.tiktok.com/@someone/video/123456',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/abc123',
      'https://clips.twitch.tv/SomeClipName',
      'https://x.com/someone/status/123',
      'https://www.instagram.com/reel/abc/',
      'https://medal.tv/games/clip/xyz',
      'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
    ]) {
      assert.equal(inspect({ ...base, content: `look ${url}` }, rules).kind, 'media', url);
    }
  });

  it('treats a text-only message as not media (acceptance test 3)', () => {
    const verdict = inspect({ ...base, content: 'hello everyone' }, rules);
    assert.equal(verdict.kind, 'none');
    assert.equal(verdict.reason, 'text-only');
  });

  it('holds an unknown link as ambiguous rather than deleting it (acceptance test 4)', () => {
    const verdict = inspect({ ...base, content: 'read this https://example.com/article/about-things' }, rules);
    assert.equal(verdict.kind, 'ambiguous');
    assert.deepEqual(verdict.kind === 'ambiguous' ? verdict.urls : [], [
      'https://example.com/article/about-things',
    ]);
  });

  it('accepts the same message once a late embed resolves (acceptance test 4)', () => {
    const late = inspect(
      { ...base, content: 'https://example.com/x', embeds: [{ type: 'video', hasVideo: true }] },
      rules,
    );
    assert.equal(late.kind, 'media');
  });

  it('does not count a bare provider domain as media', () => {
    assert.equal(classifyUrl('https://youtube.com', rules), 'unknown');
    assert.equal(classifyUrl('https://youtube.com/watch?v=abc', rules), 'provider');
  });

  it('honours the blocklist over the allowlist', () => {
    const blocked: MediaRules = { ...rules, blockedProviders: ['tiktok.com'] };
    assert.equal(classifyUrl('https://tiktok.com/@a/video/1', blocked), 'blocked');
    assert.equal(inspect({ ...base, content: 'https://tiktok.com/@a/video/1' }, blocked).kind, 'none');
  });

  it('respects the audio toggle', () => {
    const message = { ...base, attachments: [{ contentType: 'audio/mpeg', name: 'sound.mp3' }] };
    assert.equal(inspect(message, rules).kind, 'none');
    assert.equal(inspect(message, { ...rules, allowAudio: true }).kind, 'media');
  });

  it('pulls urls out of surrounding punctuation', () => {
    assert.deepEqual(extractUrls('see (https://a.test/clip.mp4) ok'), ['https://a.test/clip.mp4']);
  });
});
