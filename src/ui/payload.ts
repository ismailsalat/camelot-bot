import type { MessageRow } from './types.js';

export interface Payload {
  content?: string;
  components?: MessageRow[];
}

/**
 * Discord rejects a message that has no content, embeds, files or stickers —
 * action rows alone are not enough. Every renderer goes through here so a
 * component-only screen can never silently fail to open again.
 */
export function isSendable(payload: Payload): boolean {
  return typeof payload.content === 'string' && payload.content.trim().length > 0;
}

/** Last line of defence: never hand Discord an empty message. */
export function ensureSendable(payload: Payload, fallback = 'Done.'): Payload {
  return isSendable(payload) ? payload : { ...payload, content: fallback };
}
