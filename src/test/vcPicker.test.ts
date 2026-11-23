import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { choose, type VcOption } from '../features/vcPicker.js';

function option(overrides: Partial<VcOption> & { id: string; name: string }): VcOption {
  return {
    userLimit: 0,
    occupancy: 0,
    isAfk: false,
    botCanView: true,
    blockedUserIds: [],
    priority: Number.MAX_SAFE_INTEGER,
    reserved: false,
    ...overrides,
  };
}

const defaults = { attendeeCount: 3, allowShared: false, requireCapacity: true };

describe('voice channel selection (acceptance test 9)', () => {
  it('prefers an empty channel', () => {
    const result = choose({
      ...defaults,
      options: [option({ id: 'a', name: 'Gaming', occupancy: 2 }), option({ id: 'b', name: 'Chill' })],
    });
    assert.equal(result.channelId, 'b');
    assert.match(result.reason, /empty/);
  });

  it('breaks a tie on the configured priority order', () => {
    const result = choose({
      ...defaults,
      options: [
        option({ id: 'a', name: 'Zulu', priority: 1 }),
        option({ id: 'b', name: 'Alpha', priority: 0 }),
      ],
    });
    assert.equal(result.channelId, 'b');
  });

  it('skips the AFK channel', () => {
    const result = choose({ ...defaults, options: [option({ id: 'afk', name: 'AFK', isAfk: true })] });
    assert.equal(result.channelId, null);
  });

  it('skips a channel the bot cannot see', () => {
    const result = choose({ ...defaults, options: [option({ id: 'a', name: 'Secret', botCanView: false })] });
    assert.equal(result.channelId, null);
  });

  it('skips a channel an attendee cannot join, and says how many', () => {
    const result = choose({
      ...defaults,
      options: [option({ id: 'a', name: 'Staff', blockedUserIds: ['u1', 'u2'] })],
    });
    assert.equal(result.channelId, null);
    assert.match(result.reason, /2 can't join/);
  });

  it('skips a channel that is too small for the group', () => {
    const result = choose({
      ...defaults,
      attendeeCount: 5,
      options: [option({ id: 'a', name: 'Duo', userLimit: 2 })],
    });
    assert.equal(result.channelId, null);
    assert.match(result.reason, /not enough room/);
  });

  it('ignores the user limit when the admin turns that check off', () => {
    const result = choose({
      ...defaults,
      attendeeCount: 5,
      requireCapacity: false,
      options: [option({ id: 'a', name: 'Duo', userLimit: 2 })],
    });
    assert.equal(result.channelId, 'a');
  });

  it('never takes a channel reserved by another live session', () => {
    const result = choose({ ...defaults, options: [option({ id: 'a', name: 'General', reserved: true })] });
    assert.equal(result.channelId, null);
  });

  it('refuses to share a busy channel unless sharing is allowed', () => {
    const busy = [option({ id: 'a', name: 'General', occupancy: 2, userLimit: 10 })];
    assert.equal(choose({ ...defaults, options: busy }).channelId, null);

    const shared = choose({ ...defaults, allowShared: true, options: busy });
    assert.equal(shared.channelId, 'a');
    assert.match(shared.reason, /sharing/);
  });

  it('shares the least occupied channel when sharing is on', () => {
    const result = choose({
      ...defaults,
      allowShared: true,
      options: [
        option({ id: 'a', name: 'Busy', occupancy: 4, userLimit: 10 }),
        option({ id: 'b', name: 'Quieter', occupancy: 1, userLimit: 10 }),
      ],
    });
    assert.equal(result.channelId, 'b');
  });

  it('is honest when nothing is configured', () => {
    const result = choose({ ...defaults, options: [] });
    assert.equal(result.channelId, null);
    assert.match(result.reason, /no eligible voice channels/);
  });
});
