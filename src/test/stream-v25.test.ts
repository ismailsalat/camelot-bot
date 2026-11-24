import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseEpisodeInput} from '../streaming/episodes.js';
import {panel} from '../streaming/ui.js';
import type {Episode,Session} from '../streaming/model.js';

const eps=(n:number,from=1):Episode[]=>Array.from({length:n},(_,i)=>({id:`episode:${from+i}`,number:from+i,title:`Episode ${from+i}`}));
const dbz=eps(291);

test('typing an episode number jumps straight to it',()=>{
  assert.equal(dbz[parseEpisodeInput('206',dbz,0)]!.number,206);
  for(const t of ['ep 206','E206','#206','episode 206',' 206 '])assert.equal(dbz[parseEpisodeInput(t,dbz,0)]!.number,206,t);
  assert.equal(dbz[parseEpisodeInput('+5',dbz,205)]!.number,211);
  assert.equal(dbz[parseEpisodeInput('-3',dbz,205)]!.number,203);
  assert.equal(dbz[parseEpisodeInput('last',dbz,0)]!.number,291);
  assert.equal(dbz[parseEpisodeInput('first',dbz,50)]!.number,1);
});

test('a bad episode says what is wrong and what exists',()=>{
  assert.throws(()=>parseEpisodeInput('500',dbz,0),/Episode 500 doesn't exist\. The last episode is 291\./);
  assert.throws(()=>parseEpisodeInput('0',dbz,0),/starts at episode 1/);
  assert.throws(()=>parseEpisodeInput('abc',dbz,0),/not an episode number.*episodes 1–291/);
  assert.throws(()=>parseEpisodeInput('',dbz,0),/Type an episode number/);
  assert.throws(()=>parseEpisodeInput('+100',dbz,250),/Only 40 episodes left/);
  assert.throws(()=>parseEpisodeInput('-5',dbz,2),/only 2 episodes before/);
  assert.throws(()=>parseEpisodeInput('1',[],0),/No episodes/);
});

test('a gap in the sources is explained, not silently mapped to another episode',()=>{
  const gappy=[...eps(5),...eps(5,8)];
  assert.throws(()=>parseEpisodeInput('6',gappy,0),/isn't listed.*Closest: 5 or 8/);
  assert.equal(gappy[parseEpisodeInput('9',gappy,0)]!.number,9);
});

test('the panel has Go to episode and Skip intro (the 10 s / 30 s buttons are gone), and skipping needs a known duration',()=>{
  const base={id:'s',guild:'g',channel:'c',owner:'u',title:{id:'x',provider:'megaplay',title:'Dragon Ball Z'},episodes:dbz,episode:5,sources:['megaplay'],source:'auto',lang:'dub',phase:'playing',position:30,duration:1400,changed:Date.now(),note:''} as Session;
  const find=(s:Session)=>{const out:any[]=[];const walk=(n:any)=>{if(!n)return;if(n.custom_id||n.data?.custom_id)out.push(n.data??n);for(const k of Object.values(n.data??n))if(typeof k==='object')walk(k)};walk(panel(s,0).toJSON());return out};
  const all=find(base).filter(b=>/goep|skipb|skipf|skipop/.test(b.custom_id||''));
  assert.deepEqual(all.map(b=>b.custom_id.split(':')[2]).sort(),['goep','skipop']);
  assert.ok(all.every(b=>!b.disabled));
  const idle=find({...base,phase:'idle',duration:null}).filter(b=>/skip/.test(b.custom_id||''));
  assert.ok(idle.length===1&&idle.every(b=>b.disabled));
  assert.equal(find(base).filter(b=>/skipb|skipf/.test(b.custom_id||'')).length,0);
});

import {StallWatch} from '../streaming/stall.js';
test('stall detection: the real log (27 s -> 29 s in 30 s) is a freeze; normal playback and a seek are not',()=>{
  const w=new StallWatch();let t=1_000_000;
  // normal playback: +1 s of video per second
  assert.equal(w.check(10,t,60000),null);
  assert.equal(w.check(15,t+5000,60000),null);
  const ok=w.check(22,t+12000,60000);assert.equal(ok?.healthy,true);
  // frozen: video creeps 2 s in 30 s
  const f=new StallWatch();
  assert.equal(f.check(27,t,60000),null);
  assert.equal(f.check(27.5,t+6000,60000),null);
  const bad=f.check(27.8,t+13000,60000);
  assert.equal(bad?.healthy,false);assert.ok(bad!.advanced<1&&bad!.elapsed>=12);
  // a seek forward is progress, a seek backward restarts the window, and the first seconds after a (re)start are ignored
  const s=new StallWatch();s.check(10,t,60000);assert.equal(s.check(300,t+13000,60000)?.healthy,true);
  const b=new StallWatch();b.check(100,t,60000);assert.equal(b.check(20,t+13000,60000),null);
  const fresh=new StallWatch();assert.equal(fresh.check(0,t,1000),null);assert.equal(fresh.check(0,t+13000,2000),null);
});
