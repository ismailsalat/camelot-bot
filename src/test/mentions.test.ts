import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NO_MENTIONS, onlyUser } from '../util/mentions.js';

/**
 * Cards carry @mentions on purpose: a leaderboard row, a review card and a
 * removal list are all places where you want a profile one tap away. That only
 * stays safe because every send suppresses mentions — a purge confirmation
 * listing twenty people would otherwise ping all twenty.
 *
 * So this reads the source. A unit test can only cover the payloads that exist
 * today; the risk is the twenty-first payload, written later, that forgets.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'test') continue;
      out.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Object literals that look like something being sent to Discord. */
function payloads(source: string): string[] {
  const found: string[] = [];
  const pattern = /\{[^{}]*components:\s*\[[^\]]*\][^{}]*\}/gs;
  for (const match of source.matchAll(pattern)) {
    // `flags` is what distinguishes a send payload from a builder call.
    if (match[0].includes('flags')) found.push(match[0]);
  }
  return found;
}

describe('nothing Camelot sends can ping anyone', () => {
  const files = sourceFiles('src');

  it('finds the payloads to check', () => {
    const total = files.reduce((sum, file) => sum + payloads(readFileSync(file, 'utf8')).length, 0);
    assert.ok(total >= 10, `expected to find payloads to check, found ${total}`);
  });

  it('suppresses mentions on every payload in the source', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const payload of payloads(readFileSync(file, 'utf8'))) {
        if (!payload.includes('allowedMentions')) {
          offenders.push(`${file}: ${payload.replace(/\s+/g, ' ').slice(0, 100)}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `payloads missing allowedMentions:\n${offenders.join('\n')}`);
  });

  it('sets the client-wide default too, as a backstop', () => {
    const index = readFileSync('src/index.ts', 'utf8');
    assert.match(index, /allowedMentions:\s*NO_MENTIONS/);
  });

  it('suppresses everything, including @everyone and roles', () => {
    assert.deepEqual(NO_MENTIONS, { parse: [], roles: [], users: [] });
  });

  it('lets a deliberate single ping through, and nothing else', () => {
    assert.deepEqual(onlyUser('u1'), { parse: [], roles: [], users: ['u1'] });
  });
});

describe('a member who has left is an everyday event, not an error', () => {
  it('treats unknown member and unknown user as soft', async () => {
    // Camelot fetches members who may have gone on almost every screen. These
    // being hard errors filled the log with noise that hid real failures.
    const { SOFT_ERRORS } = await import('../util/discord.js');
    assert.ok(SOFT_ERRORS.has(10007), 'Unknown Member');
    assert.ok(SOFT_ERRORS.has(10013), 'Unknown User');
  });

  it('still treats a genuine failure as an error', async () => {
    const { SOFT_ERRORS } = await import('../util/discord.js');
    for (const code of [50035, 40001, 20028]) {
      assert.ok(!SOFT_ERRORS.has(code), `${code} must not be swallowed`);
    }
  });
});
