import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDatabase} from '../db/index.js';
import {clearSettingsCache,setByPath} from '../db/settings.js';
import {BotTimeline} from '../streaming/timeline.js';
import {relayTvLine} from '../streaming/bridge.js';
import {settingsCard} from '../streaming/ui.js';
import {Streaming} from '../streaming/service.js';
process.env.STREAMING_SECRET_KEY='ab'.repeat(32);
beforeEach(()=>{openTestDatabase();clearSettingsCache();setByPath('guild','modules.streaming',true)});

test('timeline marks carry UTC time and a monotonic offset, redact links and stay bounded',()=>{
  const t=new BotTimeline(5);
  for(let n=0;n<9;n++)t.mark('x',{cid:'c',n,url:'https://cdn.example/a.m3u8?token=SECRET',note:'see https://a.b/c?sig=ZZ'});
  const rows=t.all();assert.equal(rows.length,5);
  assert.match(rows[0]!.utc,/^\d{4}-\d\d-\d\dT.*Z$/);assert.equal(typeof rows[0]!.t_ms,'number');
  assert.ok(!/SECRET|ZZ|cdn\.example/.test(JSON.stringify(rows)));
});

test('intervals are null until both marks exist',()=>{
  const t=new BotTimeline();
  t.mark('play_requested',{cid:'a'});
  assert.equal(t.summary('a').command_to_play_ack_ms,null);
  t.mark('play_acked',{cid:'a'});
  assert.equal(typeof t.summary('a').command_to_play_ack_ms,'number');
});

test('TV log lines keep their severity in the bot log',()=>{
  const seen:string[]=[];
  const orig={e:console.error,w:console.warn,l:console.log};
  console.error=(m:string)=>{seen.push('E '+m)};console.warn=(m:string)=>{seen.push('W '+m)};console.log=(m:string)=>{seen.push('I '+m)};
  try{
    relayTvLine('[error] Playback interrupted (ffmpeg_exit_1)');
    relayTvLine('[warning] worker: Removed from the voice channel');
    relayTvLine('[info] Connected');
    relayTvLine('plain line');
    relayTvLine('Traceback...',true);
  }finally{console.error=orig.e;console.warn=orig.w;console.log=orig.l}
  assert.match(seen[0]!,/^E .*ERROR.*\[tv\] Playback interrupted/);
  assert.match(seen[1]!,/^W .*WARN/);
  assert.match(seen[2]!,/^I .*INFO/);
  assert.match(seen[3]!,/^I /);
  assert.match(seen[4]!,/^E /);
});

test('the settings card keeps every button row within Discord’s limit of five',()=>{
  const card:any=settingsCard({guild:{id:'guild'}} as never).toJSON();
  const rows=card.components.filter((c:any)=>c.type===1);
  assert.ok(rows.length>=2);
  for(const r of rows)assert.ok(r.components.length<=5,`row has ${r.components.length}`);
  const ids=rows.flatMap((r:any)=>r.components.map((b:any)=>b.custom_id));
  assert.ok(ids.includes('tvs:export'));assert.ok(ids.includes('tvs:debugmode'));
});

test('the diagnostics export has no links or secrets, even when the TV service is down',async()=>{
  const tv:any=new Streaming();
  tv.bridge={get running(){return false}};
  const file:any=await tv.diagnosticsFile();
  const text=Buffer.from(file.attachment).toString('utf8');
  assert.match(file.name,/^camelot-streaming-diagnostics-.*\.json$/);
  assert.ok(!/https?:\/\//.test(text));
  assert.equal(JSON.parse(text).tv.error,'TV service is not running');
});

import {buildFamily} from '../streaming/seasons.js';
test('two adaptations of one story are not shown as season 1 and season 2',()=>{
  const rows=[{id:'1',provider:'p',title:'Hunter x Hunter (1999)'},{id:'2',provider:'p',title:'Hunter x Hunter (2011)'}];
  assert.deepEqual(buildFamily(rows[1]!,rows),[]);
  assert.deepEqual(buildFamily(rows[0]!,rows),[]);
});
test('real seasons of one adaptation are still grouped',()=>{
  const rows=[{id:'1',provider:'p',title:'Dr. Stone'},{id:'2',provider:'p',title:'Dr. Stone: Stone Wars'},{id:'3',provider:'p',title:'Dr. Stone Season 3'}];
  assert.ok(buildFamily(rows[0]!,rows).length>=2);
});
