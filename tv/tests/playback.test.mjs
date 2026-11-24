import test from 'node:test';
import assert from 'node:assert/strict';
import {candidatePlan,filterSourceSearchResults,tryPlayableEpisode} from '../src/playback.mjs';
const original={id:'a:drstone',provider:'animeparadise',title:'Dr. STONE',year:2019};
const primary={provider:'animeparadise',unit:'a:episode1'};
const found=[original,
 {id:'b:drstone',provider:'allmanga',title:'Dr STONE',year:null},
 {id:'c:drstone',provider:'megaplay',title:'Dr. Stone',year:2019},
 {id:'d:drstone',provider:'anikoto',title:'Dr. Stone',year:2019},
 {id:'fake',provider:'allmanga',title:'Dr. Stone: Stone Wars',year:2021},
 {id:'wrong',provider:'gogoanime',title:'Dr. Stone',year:2025},
 {id:'meta',provider:'catalog',title:'Dr. STONE'}];
test('fallback plans all exact matches and rejects other seasons/years',()=>{
 const q=candidatePlan(primary,original,found);
 assert.deepEqual(q.map(x=>x.provider),['animeparadise','anikoto','megaplay','allmanga']);
});
test('source search rejects partial unrelated matches',()=>{
 const x=filterSourceSearchResults('Dr Stone',[...found,{title:'Dragon',provider:'anikoto'},{title:'Swan',provider:'anikoto'}]);
 assert.equal(x.some(r=>r.title==='Dragon'||r.title==='Swan'),false);
 assert.equal(x.some(r=>r.title==='Dr. Stone: Stone Wars'),true);
 assert.equal(x.length,7);
});
test('reaches the fourth provider after three source failures',async()=>{
 const plan=candidatePlan(primary,original,found);
 const tried=[];
 const result=await tryPlayableEpisode({queue:plan,episode:{number:1},language:'sub',
  list:async(p,m)=>[{number:1,id:`${p}:e1`,languages:['sub']}],
  resolve:async p=>{tried.push(p);if(p==='animeparadise')throw Error('HTTP 429');if(p==='allmanga')return [{url:'https://good.example.org/1.m3u8',quality:'720p'}];return []},
  rank:x=>x,probe:async()=>{},onSuccess:async()=>{}});
 assert.equal(result.provider,'allmanga');
 assert.deepEqual(tried,['animeparadise','anikoto','megaplay','allmanga']);
 assert.equal(result.failures.length,3);
});
test('never silently substitutes a different episode number',async()=>{
 const plan=candidatePlan(primary,original,found);
 const tried=[];
 await assert.rejects(tryPlayableEpisode({queue:plan,episode:{number:2},language:'dub',
  list:async p=>[{id:p+':ep1',number:1,languages:['dub']}],
  resolve:async p=>{tried.push(p);throw Error('no stream')},
  rank:x=>x,probe:async()=>{},onSuccess:async()=>{}}),/No playable video/);
 assert.deepEqual(tried,[]);
});
test('all provider failures are reported and do not start Go Live',async()=>{
 const plan=candidatePlan(primary,original,found);
 let fired=false;
 await assert.rejects(tryPlayableEpisode({queue:plan,episode:{number:1},language:'sub',
  list:async p=>[{number:1,id:`${p}:e1`,languages:['sub']}],
  resolve:async p=>{throw Error(p+' source unavailable')},
  rank:x=>x,probe:async()=>{},onSuccess:async()=>{fired=true}}),e=>e.failures.length===4 && /megaplay/.test(e.message));
 assert.equal(fired,false);
});
