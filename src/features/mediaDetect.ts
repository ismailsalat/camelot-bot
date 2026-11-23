/**
 * Decides whether a message in #clips counts as media.
 *
 * Deliberately works on a plain data shape rather than a discord.js Message so
 * the rules can be unit-tested without a gateway connection.
 */

export interface MediaRules {
  allowImages: boolean;
  allowVideos: boolean;
  allowAudio: boolean;
  allowStickers: boolean;
  providers: string[];
  blockedProviders: string[];
}

export interface InspectAttachment {
  contentType?: string | null;
  name?: string | null;
  url?: string | null;
}

export interface InspectEmbed {
  type?: string | null;
  url?: string | null;
  hasImage?: boolean;
  hasVideo?: boolean;
  hasThumbnail?: boolean;
}

export interface InspectInput {
  content: string;
  attachments: InspectAttachment[];
  embeds: InspectEmbed[];
  stickerCount: number;
}

export type Verdict =
  /** Definitely media — keep it and add the vote reactions. */
  | { kind: 'media'; reason: string }
  /** Definitely not media — delete it. */
  | { kind: 'none'; reason: string }
  /**
   * Has a link we don't recognise. Discord may still attach a preview a moment
   * later, so the caller waits out the grace period and re-checks before
   * deleting anything.
   */
  | { kind: 'ambiguous'; reason: string; urls: string[] };

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'gifv', 'webp', 'bmp', 'heic', 'heif', 'avif', 'apng', 'tiff'];
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg', '3gp'];
const AUDIO_EXT = ['mp3', 'ogg', 'oga', 'wav', 'm4a', 'flac', 'opus', 'aac'];

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

export function extractUrls(content: string): string[] {
  const found = content.match(URL_PATTERN) ?? [];
  return found.map((raw) => raw.replace(/[),.!?\]}>]+$/, '')).filter(Boolean);
}

function extensionOf(value: string | null | undefined): string | null {
  if (!value) return null;
  let path = value;
  try {
    if (/^https?:\/\//i.test(value)) path = new URL(value).pathname;
  } catch {
    /* fall through to raw string handling */
  }
  const match = /\.([a-z0-9]{2,5})$/i.exec(path.split('?')[0] ?? path);
  return match ? match[1]!.toLowerCase() : null;
}

type Category = 'image' | 'video' | 'audio' | null;

function categorise(contentType?: string | null, name?: string | null, url?: string | null): Category {
  const mime = (contentType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  const ext = extensionOf(name) ?? extensionOf(url);
  if (!ext) return null;
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}

function categoryAllowed(category: Category, rules: MediaRules): boolean {
  if (category === 'image') return rules.allowImages;
  if (category === 'video') return rules.allowVideos;
  if (category === 'audio') return rules.allowAudio;
  return false;
}

function hostMatches(host: string, entry: string): boolean {
  const needle = entry.trim().toLowerCase().replace(/^\*?\./, '');
  if (!needle) return false;
  return host === needle || host.endsWith(`.${needle}`);
}

export type LinkKind = 'direct' | 'provider' | 'blocked' | 'unknown';

export function classifyUrl(raw: string, rules: MediaRules): LinkKind {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'unknown';
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  if (rules.blockedProviders.some((entry) => hostMatches(host, entry))) return 'blocked';

  const category = categorise(null, null, raw);
  if (category && categoryAllowed(category, rules)) return 'direct';

  // A bare domain ("youtube.com") is a site, not a piece of media.
  const hasPath = url.pathname.length > 1 || url.search.length > 0;
  if (hasPath && rules.providers.some((entry) => hostMatches(host, entry))) return 'provider';

  return 'unknown';
}

export function inspect(input: InspectInput, rules: MediaRules): Verdict {
  for (const attachment of input.attachments) {
    const category = categorise(attachment.contentType, attachment.name, attachment.url);
    if (category && categoryAllowed(category, rules)) {
      return { kind: 'media', reason: `attachment:${category}` };
    }
  }

  if (rules.allowStickers && input.stickerCount > 0) {
    return { kind: 'media', reason: 'sticker' };
  }

  for (const embed of input.embeds) {
    const type = (embed.type ?? '').toLowerCase();
    if (type === 'image' || type === 'gifv' || type === 'video') {
      return { kind: 'media', reason: `embed:${type}` };
    }
    if (embed.hasImage || embed.hasVideo) {
      return { kind: 'media', reason: 'embed:attachment' };
    }
  }

  const urls = extractUrls(input.content);
  const kinds = urls.map((url) => classifyUrl(url, rules));

  if (kinds.includes('direct')) return { kind: 'media', reason: 'link:direct' };
  if (kinds.includes('provider')) return { kind: 'media', reason: 'link:provider' };

  const unknowns = urls.filter((_, index) => kinds[index] === 'unknown');
  if (unknowns.length > 0) {
    // Could still turn into a preview — let the caller wait before deleting.
    return { kind: 'ambiguous', reason: 'link:unknown', urls: unknowns };
  }

  if (kinds.includes('blocked')) return { kind: 'none', reason: 'link:blocked' };
  return { kind: 'none', reason: 'text-only' };
}
