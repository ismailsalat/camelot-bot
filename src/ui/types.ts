import type { APIActionRowComponent, APIComponentInMessageActionRow } from 'discord.js';

/** A serialized action row, ready to hand to Discord. */
export type MessageRow = APIActionRowComponent<APIComponentInMessageActionRow>;
