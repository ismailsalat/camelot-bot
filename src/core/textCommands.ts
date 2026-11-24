import { PermissionFlagsBits, type Message } from 'discord.js';
import { errorNotice, notice, V2_PUBLIC } from './ui.js';
import { parseCommand, prefixFor, resolveTarget, textCommandsEnabled } from './prefix.js';
import { runCommand } from './dispatch.js';
import { commandByName } from './registry.js';
import { NO_MENTIONS } from '../util/mentions.js';
import { streaming } from '../streaming/service.js';
import { log } from '../logger.js';

/**
 * `!allies`, `!purge @gail` — the same commands, asked the short way.
 *
 * A slash command answers privately. A text command cannot: it is an ordinary
 * message in an ordinary channel, so the answer is visible. Every button the
 * answer carries re-checks permissions server-side, and a refusal replies
 * privately rather than wiping the card for everyone else reading it.
 */

/** Literal !stream remains a fallback when a custom prefix or text switch is set.
 * Streaming's module, voice and controller permissions still apply. */
export function parseTextCommand(content:string,guildId:string){
  if(/^!stream(?:\s|$)/i.test(content))return parseCommand(content,'!');
  return textCommandsEnabled(guildId)?parseCommand(content,prefixFor(guildId)):null;
}

/** Cheap enough to call on every message in the server. */
export function looksLikeTextCommand(message: Message<true>): boolean {
  if (message.author.bot || message.system) return false;
  return parseTextCommand(message.content ?? '', message.guildId) !== null;
}

export async function handleTextCommand(message: Message<true>): Promise<void> {
  if (message.author.bot || message.system) return;
  if (!message.member) return;
  const parsed = parseTextCommand(message.content ?? '', message.guildId);
  if (!parsed) return;

  // Nothing is said in a channel Camelot cannot speak in — a silent failure is
  // better than an error loop against Discord.
  const me = message.guild.members.me;
  const channel = message.channel;
  if (!me || !channel.isTextBased() || channel.isDMBased()) return;
  const allowed = channel.permissionsFor(me);
  if (!allowed?.has(PermissionFlagsBits.SendMessages) || !allowed.has(PermissionFlagsBits.ViewChannel)) return;

  if(parsed.name==='stream'){
    if(parsed.args.length){await send(message,notice('Use !stream by itself, then choose Find anime in the VC controls.'));return}
    await streaming.handleText(message);return;
  }

  const spec = commandByName(parsed.name);

  // Some answers do not belong in a channel everyone can read.
  if (spec?.slashOnly) {
    await send(message, notice(`Use \`/${spec.name}\` for that one — it answers just to you.`));
    return;
  }

  const target = await resolveTarget(message.guild, parsed.args);
  if (target === 'not-found') {
    await send(message, errorNotice(`I can't find "${clip(parsed.args.join(' '))}". Try an @mention.`));
    return;
  }

  if (spec?.textNeedsTarget && !target) {
    await send(
      message,
      notice(
        `\`${prefixFor(message.guildId)}${parsed.typed} @someone\` reviews one person. ` +
          `For the full review use \`/${spec.name}\`, which answers just to you.`,
      ),
    );
    return;
  }

  const result = await runCommand({
    name: parsed.name,
    member: message.member,
    guild: message.guild,
    client: message.client,
    target,
  });

  const body =
    result.kind === 'card'
      ? result.body
      : result.kind === 'error'
        ? errorNotice(result.message)
        : notice(result.message);

  await send(message, body);
}

/** Keep a bad lookup from echoing a wall of text back into the channel. */
function clip(value: string): string {
  const trimmed = value.trim().replace(/[`*_~|]/g, '');
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}

async function send(message: Message<true>, body: unknown): Promise<void> {
  try {
    // Not ephemeral: a channel message cannot be. Nothing pings, and every
    // button on the card re-checks who pressed it.
    await message.reply({
      components: [body],
      flags: V2_PUBLIC,
      allowedMentions: NO_MENTIONS,
    } as never);
  } catch (error) {
    log.debug(`Could not answer a text command in ${message.channelId}: ${String(error)}`);
  }
}
