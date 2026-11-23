import type { Client, Guild, GuildMember } from 'discord.js';
import { getSettings } from '../db/settings.js';
import { isAdmin, tierOf } from './permissions.js';
import { isModuleEnabled } from './registry.js';
import { renderHelpHome } from './help.js';
import { renderHome as renderSettingsHome } from './settingsUi.js';
import * as activityUi from '../activity/ui.js';
import * as purgeUi from '../purge/ui.js';
import { summarise } from '../activity/summary.js';
import { revalidate } from '../purge/execute.js';

/**
 * One place where a command decides what to show, whatever way it was asked.
 *
 * `/allies @gail` and `!allies @gail` must not be able to answer differently,
 * so neither of them has its own copy of the rules: both build a request, call
 * `runCommand`, and only the sending differs.
 */

export interface CommandRequest {
  /** Canonical name — an alias is resolved before it gets here. */
  name: string;
  member: GuildMember;
  guild: Guild;
  client: Client;
  /** The member named on the command, when one was named and found. */
  target?: GuildMember | null;
}

export type CommandResult =
  | { kind: 'card'; body: unknown }
  | { kind: 'notice'; message: string }
  | { kind: 'error'; message: string };

export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  const { name, member, guild, client } = request;
  const settings = getSettings(guild.id);
  const target = request.target ?? null;

  switch (name) {
    case 'help':
      return { kind: 'card', body: renderHelpHome(member, client) };

    case 'settings': {
      if (!isAdmin(member)) return { kind: 'error', message: 'Admins only.' };
      return { kind: 'card', body: renderSettingsHome(member) };
    }

    case 'activity': {
      if (!isModuleEnabled(settings, 'activity')) {
        return { kind: 'notice', message: 'Activity is turned off.' };
      }
      // Your own card is always yours to see. Someone else's is an admin view,
      // checked here and again on every button the card carries.
      const subject = target ?? member;
      if (subject.id !== member.id && !isAdmin(member)) {
        return { kind: 'error', message: "You can only look up your own activity." };
      }
      if (subject.user.bot) {
        return { kind: 'notice', message: 'Bots are not tracked.' };
      }
      return { kind: 'card', body: activityUi.renderMemberCard(subject, member, client) };
    }

    case 'purge': {
      if (!isModuleEnabled(settings, 'purge')) {
        return { kind: 'notice', message: 'The Purge needs Activity turned on.' };
      }
      if (!isAdmin(member)) return { kind: 'error', message: 'Admins only.' };

      // Named someone? Skip the queue entirely and go straight to them.
      if (target) {
        if (target.user.bot) return { kind: 'notice', message: 'That is a bot. Kick it from Discord instead.' };
        if (target.id === member.id) return { kind: 'notice', message: 'You cannot purge yourself.' };

        const verdicts = await revalidate(guild, [target.id], member.id, {});
        const verdict = verdicts[0];
        if (!verdict) return { kind: 'error', message: 'Could not check that member.' };

        return {
          kind: 'card',
          body: purgeUi.renderOneCard(
            target,
            summarise(guild.id, target.id, settings),
            verdict,
            member.id,
            client,
          ),
        };
      }

      const tier = tierOf(member);
      return {
        kind: 'card',
        body: purgeUi.renderStart(guild, purgeUi.scopeCounts(guild, Date.now(), tier), client),
      };
    }

    default:
      return { kind: 'error', message: 'I do not know that one.' };
  }
}
