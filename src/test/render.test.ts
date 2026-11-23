import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS } from '../db/settings.js';
import type { SessionRow } from '../db/repos.js';
import { renderSession, renderSessionContent, renderStartNotice } from '../ui/render.js';

const START = 1_763_522_000_000;

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 1,
    guild_id: 'g1',
    channel_id: 'c1',
    message_id: 'm1',
    organizer_id: 'ayub',
    game: 'Marvel Rivals',
    game_id: 'rivals',
    start_at: START,
    status: 'scheduled',
    vc_channel_id: null,
    vc_reason: null,
    started_at: null,
    closed_at: null,
    created_at: START - 60_000,
    ...overrides,
  };
}

describe('the session post (acceptance tests 7 and 8)', () => {
  it('is three short lines at most, with a local-time stamp', () => {
    const content = renderSessionContent({
      session: session(),
      names: ['Ayub', 'Abdi'],
      settings: DEFAULT_SETTINGS,
    });
    assert.match(content, /\*\*Marvel Rivals\*\*/);
    assert.match(content, /<t:1763522000:t>/, 'uses a Discord timestamp, not a hardcoded clock');
    assert.match(content, /\*\*2 down:\*\* Ayub, Abdi/);
    assert.ok(content.split('\n').length <= 3);
  });

  it('shows the chosen voice channel once the session is live', () => {
    const content = renderSessionContent({
      session: session({ status: 'live', vc_channel_id: 'v1' }),
      names: ['Ayub'],
      settings: DEFAULT_SETTINGS,
      voiceChannelName: 'General',
    });
    assert.match(content, /🔊 \*\*General\*\*/);
  });

  it('says so honestly when no voice channel was free', () => {
    const content = renderSessionContent({
      session: session({ status: 'live', vc_reason: 'every eligible channel is in use' }),
      names: ['Ayub'],
      settings: DEFAULT_SETTINGS,
    });
    assert.match(content, /No free VC/);
    assert.doesNotMatch(content, /🔊 \*\*/, 'must never claim a channel it did not get');
  });

  it('offers a real voice-channel URL, not a fake button (acceptance test 10)', () => {
    const view = renderSession({
      session: session({ status: 'live', vc_channel_id: 'v1' }),
      names: ['Ayub'],
      settings: DEFAULT_SETTINGS,
      voiceChannelName: 'General',
    });
    const row = view.components[0] as { components: { url?: string; label?: string }[] };
    const link = row.components.find((component) => component.label === 'Join VC');
    assert.equal(link?.url, 'https://discord.com/channels/g1/v1');
  });

  it('shows a Find VC button only when live with nothing picked', () => {
    const labels = (row: unknown) =>
      (row as { components: { label?: string }[] }).components.map((component) => component.label);

    const live = renderSession({ session: session({ status: 'live' }), names: ['A'], settings: DEFAULT_SETTINGS });
    assert.ok(labels(live.components[0]).includes('Find a VC'));

    const scheduled = renderSession({ session: session(), names: ['A'], settings: DEFAULT_SETTINGS });
    assert.ok(!labels(scheduled.components[0]).includes('Find a VC'));
  });

  it('disables the button once the session closes (acceptance test 8)', () => {
    const view = renderSession({
      session: session({ status: 'closed' }),
      names: ['Ayub'],
      settings: DEFAULT_SETTINGS,
    });
    const row = view.components[0] as { components: { disabled?: boolean; label?: string }[] };
    assert.equal(row.components[0]?.disabled, true);
    assert.equal(row.components.length, 1, 'no join, no link, no cancel on a dead session');
    assert.match(
      renderSessionContent({ session: session({ status: 'closed' }), names: [], settings: DEFAULT_SETTINGS }),
      /Done\./,
    );
  });

  it('writes one short start notice with the voice channel in it', () => {
    const notice = renderStartNotice(
      session({ status: 'live', vc_channel_id: 'v1' }),
      'General',
      DEFAULT_SETTINGS,
    );
    assert.match(notice, /Marvel Rivals/);
    assert.match(notice, /Join us in \*\*General\*\*/);
    assert.ok(notice.split('\n').length <= 3);
  });

  it('does not pretend a voice channel exists in the start notice', () => {
    const notice = renderStartNotice(session({ status: 'live', vc_reason: 'all full' }), null, DEFAULT_SETTINGS);
    assert.match(notice, /No free VC/);
    assert.doesNotMatch(notice, /Join us in/);
  });
});
