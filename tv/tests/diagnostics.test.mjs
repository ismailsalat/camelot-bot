import test from 'node:test';
import assert from 'node:assert/strict';
import {describeVideoError} from '../src/source.mjs';

test('HTTP 429 yields an actionable cooldown message',()=>{
 assert.match(describeVideoError('HTTP error 429 Too Many Requests',8),/HTTP 429.*rate-limiting/);
});
test('HTTP 403 does not look like a local encoder failure',()=>{
 assert.match(describeVideoError('Server returned 403 Forbidden',8),/HTTP 403.*refused/);
});
test('HLS segment error is distinguishable from title-search error',()=>{
 assert.match(describeVideoError('Failed to open segment 4 of playlist',1),/HLS playlist/);
});
test('general media error never embeds a CDN URL in user-facing diagnosis',()=>{
 const message=describeVideoError('Error opening input https://example.com/token=PRIVATE. Invalid data found when processing input',1);
 assert.ok(!message.includes('PRIVATE'));
 assert.match(message,/cannot decode/);
});
test('timeout is explicit',()=>{
 assert.match(describeVideoError('',null,true),/timeout/);
});
