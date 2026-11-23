import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type Client,
} from 'discord.js';
import { type EmojiSlot, type GuildSettings } from '../db/settings.js';
import { componentEmojiFor, emojiFor } from '../util/emoji.js';

/**
 * Camelot's whole visual language lives here: one accent, one heading shape,
 * one bar, one timeline. Every screen is built from these so Help, Settings,
 * Activity and The Purge look like the same application.
 */

/**
 * Palette. Discord's dark theme sits on #313338, so the accent has to carry
 * on its own at two pixels wide. Royal violet reads as Camelot without the
 * muddiness gold picks up against dark grey, and it is far enough from
 * Discord's own blurple not to look like chrome.
 */
export const ACCENT = 0xa855f7; // royal violet — the house colour
export const ACCENT_MUTED = 0x64748b; // slate — informational, closed
export const ACCENT_GOOD = 0x22c55e; // emerald — done, kept
export const ACCENT_WARN = 0xf59e0b; // amber — needs attention
export const ACCENT_BAD = 0xef4444; // crimson — destructive

export const V2_FLAGS = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;
export const V2_PUBLIC = MessageFlags.IsComponentsV2;

export function text(content: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(content);
}

export function divider(large = false): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
}

export function spacer(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small);
}

/** `## TITLE` with a small caption under it — the top of every screen. */
export function heading(title: string, caption?: string): TextDisplayBuilder {
  return text(caption ? `## ${title}\n${caption}` : `## ${title}`);
}

export function container(accent = ACCENT): ContainerBuilder {
  return new ContainerBuilder().setAccentColor(accent);
}

/** A row of text with an avatar or image on the right. */
export function sectionWithThumb(body: string, imageUrl: string): SectionBuilder {
  return new SectionBuilder()
    .addTextDisplayComponents(text(body))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(imageUrl));
}

/** A row of text with a button on the right. */
export function sectionWithButton(body: string, button: ButtonBuilder): SectionBuilder {
  return new SectionBuilder().addTextDisplayComponents(text(body)).setButtonAccessory(button);
}

export function row(...components: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...components);
}

export function selectRow(menu: StringSelectMenuBuilder): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function button(
  customId: string,
  label: string,
  style: ButtonStyle = ButtonStyle.Secondary,
): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

export function emojiButton(
  customId: string,
  label: string,
  settings: GuildSettings,
  slot: EmojiSlot,
  style: ButtonStyle = ButtonStyle.Secondary,
  client?: Client,
): ButtonBuilder {
  return button(customId, label, style).setEmoji(componentEmojiFor(settings, slot, client));
}

/* ------------------------------- indicators -------------------------------- */

const BAR_SEGMENTS = 10;

/** Score bands, so the bar's colour says something on its own. */
export function scoreBand(score: number): 'high' | 'good' | 'low' | 'none' {
  if (score >= 70) return 'high';
  if (score >= 40) return 'good';
  if (score >= 15) return 'low';
  return 'none';
}

const BAND_BLOCK: Record<ReturnType<typeof scoreBand>, string> = {
  high: '🟩',
  good: '🟨',
  low: '🟧',
  none: '🟥',
};

/** The empty part of the track. Dark enough to recede on Discord's dark theme. */
const EMPTY_BLOCK = '⬛';

/**
 * Emoji squares rather than shaded text. Discord renders `░` as a very faint
 * pattern that all but disappears on dark, and a code span forces a font that
 * fights everything around it. Native emoji are the same size on every client,
 * and the colour carries the reading at a glance.
 */
export function bar(score: number, segments = BAR_SEGMENTS): string {
  const clamped = Math.max(0, Math.min(100, score));
  let filled = Math.round((clamped / 100) * segments);
  // Never claim empty for real activity, or full for anything short of 100.
  if (filled === 0 && clamped > 0) filled = 1;
  if (filled === segments && clamped < 100) filled = segments - 1;
  const block = BAND_BLOCK[scoreBand(clamped)];
  return block.repeat(filled) + EMPTY_BLOCK.repeat(segments - filled);
}

export type DayState = 'active' | 'idle' | 'unknown';

/**
 * A 30-day strip, grouped into weeks so it can be scanned rather than counted.
 * Untracked days look different from quiet ones on purpose: "we weren't
 * watching" is not the same claim as "they did nothing".
 */
export function timeline(days: DayState[]): string {
  const glyph = (state: DayState): string =>
    state === 'active' ? '▰' : state === 'idle' ? '▱' : '·';
  const marks = days.map(glyph);
  const weeks: string[] = [];
  for (let i = 0; i < marks.length; i += 7) weeks.push(marks.slice(i, i + 7).join(''));
  return `\`${weeks.join(' ')}\``;
}

export const TIMELINE_KEY = '`▰ active   ▱ quiet   · untracked`';

export type TrendDirection = 'up' | 'flat' | 'down' | 'none';

export function trendLabel(direction: TrendDirection): string {
  switch (direction) {
    case 'up':
      return '↑ More active';
    case 'down':
      return '↓ Less active';
    case 'flat':
      return '→ About the same';
    default:
      return 'No trend yet';
  }
}

/* --------------------------------- replies --------------------------------- */

/*
 * There is deliberately no generic "build a reply" helper here. Cards carry
 * mentions so a profile is one tap away, which means every payload has to
 * suppress them at send time — and a helper that forgot would be a silent
 * mass-ping waiting to happen. The router builds payloads itself, and a test
 * asserts no payload in the codebase omits allowedMentions.
 */

/** A one-line result, in the house style. */
export function notice(message: string, accent = ACCENT_MUTED): ContainerBuilder {
  return container(accent).addTextDisplayComponents(text(message));
}

export function errorNotice(message: string): ContainerBuilder {
  return notice(message, 0x8b3a3a);
}

export function brand(settings: GuildSettings, client?: Client): string {
  return emojiFor(settings, 'sword', client);
}

/**
 * Two stats to a line, separated by a thin divider.
 *
 * One emoji per stat turned the card into a wall of icons, and Discord renders
 * them small anyway once there is text beside them — so the emoji cost
 * legibility and bought nothing. Bold figures do the work instead.
 */
export function statRow(pairs: [string, string][]): string {
  return pairs.map(([label, value]) => `${label} **${value}**`).join('  ·  ');
}
