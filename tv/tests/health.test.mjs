import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailure,ProviderHealth} from '../src/health.mjs';
import {Timeline,redactText,redactArgs,redactDeep} from '../src/timeline.mjs';
import {normTitle,expandQuery,sameAnime,titleYear} from '../src/catalog.mjs';
import {tryPlayableEpisode} from '../src/playback.mjs';

test('failures are classified, not just "failed"',()=>{
  assert.equal(classifyFailure(Object.assign(new Error('getaddrinfo ENOTFOUND anikai.to'),{code:'ENOTFOUND'})),'dns');
  assert.equal(classifyFailure(new Error('megaplay did not answer within 9s (timed out)')),'timeout');
  assert.equal(classifyFailure(new Error('HTTP 429 Too many requests')),'rate_limit');
  assert.equal(classifyFailure(new Error('Requested episode/language unavailable')),'unavailable_episode');
  assert.equal(classifyFailure(new Error('Video check cancelled')),'cancelled');
  assert.equal(classifyFailure(new Error('No direct HTTPS video URL returned')),'parser');
  assert.equal(classifyFailure(new Error('something odd')),'unknown');
});

test('a provider that keeps failing at provider level cools down and recovers; per-title misses never cool it down',()=>{
  let now=1_000_000;const h=new ProviderHealth({now:()=>now});
  for(let i=0;i<5;i++)h.failure('p',new Error('Requested episode/language unavailable'));
  assert.equal(h.coolingDown('p'),false);
  for(let i=0;i<3;i++)h.failure('p',new Error('timed out'));
  assert.equal(h.coolingDown('p'),true);
  now+=h.baseCooldownMs+1;assert.equal(h.coolingDown('p'),false);
  h.success('p',{ms:500});assert.equal(h.entry('p').consecutive,0);
});

test('health ordering puts healthy providers first and keeps configured order otherwise',()=>{
  const h=new ProviderHealth();
  assert.deepEqual(h.order([{provider:'a'},{provider:'b'},{provider:'c'}]).map(x=>x.provider),['a','b','c']);
  h.success('c',{ms:800});
  assert.equal(h.order([{provider:'a'},{provider:'b'},{provider:'c'}])[0].provider,'c');
  for(let i=0;i<3;i++)h.failure('a',new Error('ENOTFOUND'));
  assert.equal(h.order([{provider:'a'},{provider:'b'},{provider:'c'}]).at(-1).provider,'a');
});

test('timeline records UTC time and monotonic offset, redacts secrets, stays bounded',()=>{
  const t=new Timeline({capacity:5});
  for(let i=0;i<9;i++)t.record('x',{cid:'c',n:i,url:'https://cdn.example/v.m3u8?token=SECRET',authorization:'Bearer abc',note:'see https://a.b/c?sig=ZZZ'});
  assert.equal(t.ring.length,5);
  const e=t.ring.at(-1);
  assert.match(e.utc,/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(typeof e.t_ms,'number');
  const text=JSON.stringify(t.ring);
  assert.ok(!/SECRET|ZZZ|Bearer abc|cdn\.example/.test(text));
});

test('intervals come from one process clock and are null when unmeasured',()=>{
  let m=0;const t=new Timeline({mono:()=>m});
  t.record('play_request',{cid:'a'});m=250;t.record('play_ack',{cid:'a'});
  t.record('worker_first_video_sent',{cid:'a',since_play_ms:1800});
  const s=t.summarize('a');
  assert.equal(s.command_to_ack_ms,250);
  assert.equal(s.worker_play_to_first_video_sent_ms,1800);
  assert.equal(s.worker_play_to_first_audio_sent_ms,null);
});

test('ffmpeg arguments are redacted but keep the flags',()=>{
  const out=redactArgs(['-headers','Referer: x\r\nAuthorization: y','-i','https://cdn/x.m3u8?sig=1','-vf','subtitles=/tmp/a b.ass,scale=1280:720','-c:v','libx264']);
  assert.ok(!out.join(' ').includes('cdn'));assert.ok(out.includes('libx264'));assert.ok(out.includes('-vf'));
  assert.equal(redactDeep({headers:{a:1},token:'x',ok:1}).headers,'[redacted]');
  assert.equal(redactText('GET https://a/b?token=abc'),'GET [url]');
});

test('Hunter x Hunter matches across × / x and year suffixes, but never the other series',()=>{
  assert.equal(normTitle('Hunter × Hunter'),normTitle('Hunter x Hunter'));
  assert.equal(titleYear('Hunter x Hunter (2011)'),2011);
  assert.equal(expandQuery('hxh'),'hunter x hunter');
  assert.equal(expandQuery('Naruto'),'Naruto');
  const catalog={title:'Hunter × Hunter',aliases:['Hunter x Hunter (2011)'],year:2011};
  assert.equal(sameAnime(catalog,{title:'Hunter x Hunter (2011)'}),true);
  assert.equal(sameAnime(catalog,{title:'Hunter x Hunter'}),true);
  assert.equal(sameAnime(catalog,{title:'Hunter x Hunter (1999)'}),false);
  assert.equal(sameAnime({title:'Attack on Titan'},{title:'Attack on Titan Season 2'}),false);
});

const stream=(provider)=>[{url:`https://x/${provider}.m3u8`,quality:'720p',isHLS:true,headers:{},language:'sub'}];
test('a stuck provider times out and the next one plays; failures are classified and reported',async()=>{
  const events=[],health=new ProviderHealth();
  const result=await tryPlayableEpisode({
    queue:[{provider:'slow',media:'1',unit:'u1'},{provider:'good',media:'1',unit:'u2'}],
    episode:{number:1,id:'e1'},language:'sub',providerTimeoutMs:60,concurrency:2,
    list:async()=>[],resolve:(p)=>p==='slow'?new Promise(()=>{}):new Promise(r=>setTimeout(()=>r({}),20)),
    rank:(_,l)=>stream('good'),probe:async()=>{},onSuccess:async()=>{},onEvent:e=>events.push(e),health});
  assert.equal(result.provider,'good');
  await new Promise(r=>setTimeout(r,120));   // the stuck provider gives up later; it must still be recorded
  assert.equal(health.entry('slow').lastClass,'timeout');
  assert.ok(events.some(e=>e.ev==='provider_failed'&&e.provider==='slow'));
  assert.equal(health.entry('good').successes,1);
});

test('cancellation stops the search without trying more providers',async()=>{
  let stop=false,resolved=0;
  await assert.rejects(tryPlayableEpisode({
    queue:[{provider:'a',media:'1',unit:'u'},{provider:'b',media:'1',unit:'u'}],episode:{number:1},language:'sub',concurrency:1,
    list:async()=>[],resolve:async()=>{resolved++;stop=true;return {}},rank:()=>stream('a'),probe:async()=>{},onSuccess:async()=>{},shouldStop:()=>stop}),/cancelled/i);
  assert.equal(resolved,1);
});
