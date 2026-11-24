import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSources,episodeMenu,episodeLanguages} from '../src/availability.mjs';
import {candidatePlan,tryPlayableEpisode} from '../src/playback.mjs';
import {rankedStreams} from '../src/source.mjs';
import {sameAnime} from '../src/catalog.mjs';
const primary={provider:'animeparadise',id:'animeparadise:stone',title:'Dr. STONE',year:2019};
const candidates=[primary,{provider:'anikoto',id:'anikoto:stone',title:'Dr. Stone',year:2019}];
const list=async p=>[{id:`${p}:e1`,number:1,title:'Stone World',languages:p==='animeparadise'?['sub']:['sub','dub']}];

test('Portuguese provider is never advertised as English dub or Japanese sub',()=>{
 assert.deepEqual(episodeLanguages({languages:['sub']},'goyabu'),['raw']);
});

test('sub-only primary does not hide dub available on a second source',async()=>{
 const rows=await inspectSources(primary,candidates,list),[ep]=episodeMenu(rows);
 assert.equal(ep.availability.dub.status,'listed');
 assert.deepEqual(ep.availability.dub.providers,['anikoto']);
 const resolved=[];
 const result=await tryPlayableEpisode({queue:candidatePlan({provider:primary.provider,media:primary.id},primary,candidates,'dub'),episode:ep,language:'dub',list,
  resolve:async(p,u,lang)=>{resolved.push(p);return [{sourceUrl:'https://cdn.example.com/dub.m3u8',language:lang,isHLS:true}];},rank:rankedStreams,probe:async()=>{},onSuccess:async()=>{}});
 assert.equal(result.provider,'anikoto');assert.deepEqual(resolved,['anikoto']);
});
test('failed providers mean unknown, never a claim that dub does not exist',async()=>{
 const rows=await inspectSources(primary,candidates,async p=>{if(p==='anikoto')throw Error('timeout');return list(p);});
 assert.equal(episodeMenu(rows)[0].availability.dub.status,'unknown');
 assert.equal(episodeMenu([rows[0]])[0].availability.dub.status,'not-listed');
 assert.equal(episodeMenu([rows[0]],{incomplete:true})[0].availability.dub.status,'unknown');
});
test('episode-specific languages and episode union are preserved',async()=>{
 const rows=await inspectSources(primary,candidates,async p=>p==='animeparadise'?await list(p):[...(await list(p)),{id:'anikoto:e2',number:2,title:'Two',languages:['sub']}]);
 const menu=episodeMenu(rows);assert.equal(menu.length,2);assert.equal(menu[1].availability.dub.status,'not-listed');
});
test('wrong audio returned by a provider is never accepted for dub',()=>{
 assert.equal(rankedStreams([{sourceUrl:'https://cdn.example.com/sub.mp4',language:'sub'}],'dub').length,0);
});
test('separate Dub listing is accepted without merging another season',()=>{
 assert.equal(sameAnime(primary,{title:'Dr. STONE (Dub)',year:2019}),true);
 assert.equal(sameAnime(primary,{title:'Dr. STONE Season 2 (Dub)',year:2021}),false);
 const extra={provider:'anikoto',id:'anikoto:stone-dub',title:'Dr. STONE (Dub)',year:2019};
 assert.equal(candidatePlan({provider:primary.provider,media:primary.id},primary,[...candidates,extra],'dub').length,3);
});
test('tries further video URLs when three earlier streams fail',async()=>{
 let probes=0;
 const result=await tryPlayableEpisode({queue:[{provider:'anikoto',unit:'anikoto:e1'}],episode:{number:1,languages:['dub']},language:'dub',list,
 resolve:async()=>[1,2,3,4].map(i=>({url:`https://cdn.example.com/${i}.mp4`,language:'dub'})),rank:x=>x,
 probe:async()=>{if(++probes<4)throw Error('offline');},onSuccess:async()=>{}});
 assert.equal(probes,4);assert.equal(result.provider,'anikoto');
});
test('caption preparation failure tries another source and cancelled captions are discarded',async()=>{
 let discarded=0,played=false,stop=false;
 await assert.rejects(tryPlayableEpisode({queue:[{provider:'anikoto',unit:'anikoto:e1'}],episode:{number:1},language:'sub',list,
 resolve:async()=>[{url:'https://cdn.example.com/a.mp4'}],rank:x=>x,
 prepare:async s=>{stop=true;return {...s,subtitlePath:'fixture'};},discard:async()=>{discarded++;},probe:async()=>{},
 shouldStop:()=>stop,onSuccess:async()=>{played=true;}}),/cancelled/);
 assert.equal(played,false);assert.equal(discarded,1);
});
