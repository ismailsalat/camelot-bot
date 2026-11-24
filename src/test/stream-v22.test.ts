import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDatabase} from '../db/index.js';
import {clearSettingsCache} from '../db/settings.js';
import {setLogLevel} from '../logger.js';
import {Streaming} from '../streaming/service.js';
import {panel,progressBar,episodeOptions,seasonOptions,episodePage} from '../streaming/ui.js';
import {buildFamily,withFamily,seasonText,baseKey,explicitSeason} from '../streaming/seasons.js';
import type {Session,Title} from '../streaming/model.js';

beforeEach(()=>{openTestDatabase();clearSettingsCache();setLogLevel('error')});
const t=(title:string,extra:Partial<Title>={}):Title=>({id:title,provider:'p',title,...extra});
const eps=(n:number)=>Array.from({length:n},(_,i)=>({id:'e'+(i+1),number:i+1,title:`Ep ${i+1}`,languages:['sub','dub']}));
const session=(extra:Partial<Session>={}):Session=>({id:'aaaaaaaaaaaa',guild:'g',channel:'v',owner:'u',title:t('Dr. Stone'),episodes:eps(24),episode:4,sources:['hianime'],source:'auto',lang:'sub',phase:'playing',position:631,duration:1292,changed:0,note:'',...extra});
const flat=(json:any):string=>JSON.stringify(json);

test('progress bar moves with the time and is empty-safe',()=>{
  assert.equal(progressBar(0,100,10),'●─────────');
  assert.equal(progressBar(50,100,10),'━━━━━●────');
  assert.equal(progressBar(100,100,10),'━━━━━━━━━●');
  assert.equal(progressBar(5,null,10),'──────────');
});
test('panel shows season, episode count, bar and time like 10:31 / 21:32',()=>{
  const s=session({title:{...t('Dr. Stone: Stone Wars'),season:2,family:[{...t('Dr. Stone'),season:1},{...t('Dr. Stone: Stone Wars'),season:2}]}});
  const json=flat(panel(s,0).toJSON());
  assert(json.includes('Season 2 · Episode 5 of 24 · SUB · 720p'));
  assert(json.includes('10:31 / 21:32'));assert(json.includes('━'));
  assert(!json.includes('30 sec'));
});
test('panel has season and episode dropdowns, and only offers 1080p when the source has it',()=>{
  const s=session({title:{...t('Dr. Stone'),season:1,family:[{...t('Dr. Stone'),season:1},{...t('Dr. Stone: Stone Wars'),season:2}]}});
  let ids=(panel(s,0).toJSON().components as any[]).flatMap(c=>c.type===1?c.components.map((x:any)=>x.custom_id):[]);
  assert(ids.includes('tv:aaaaaaaaaaaa:season'));assert(ids.includes('tv:aaaaaaaaaaaa:epsel'));assert(!ids.includes('tv:aaaaaaaaaaaa:quality'));
  s.hd=true;
  const rows=panel(s,0).toJSON().components as any[];
  ids=rows.flatMap(c=>c.type===1?c.components.map((x:any)=>x.custom_id):[]);
  assert(ids.includes('tv:aaaaaaaaaaaa:quality'));
  assert(rows.filter(r=>r.type===1).every(r=>r.components.length<=5));
  assert(flat(panel(s,0).toJSON()).includes('Use 1080p'));
  s.quality='1080p';assert(flat(panel(s,0).toJSON()).includes('Use 720p'));
});
test('season dropdown is hidden when there is only one season; episode dropdown when there is one episode',()=>{
  const ids=(s:Session)=>(panel(s,0).toJSON().components as any[]).flatMap(c=>c.type===1?c.components.map((x:any)=>x.custom_id):[]);
  const one=session({episodes:eps(1),episode:0});
  assert(!ids(one).includes('tv:aaaaaaaaaaaa:season'));assert(!ids(one).includes('tv:aaaaaaaaaaaa:epsel'));
});
test('source dropdown only appears after a failure',()=>{
  const ids=(s:Session)=>(panel(s,0).toJSON().components as any[]).flatMap(c=>c.type===1?c.components.map((x:any)=>x.custom_id):[]);
  assert(!ids(session()).includes('tv:aaaaaaaaaaaa:source'));
  assert(ids(session({phase:'error'})).includes('tv:aaaaaaaaaaaa:source'));
});
test('episode dropdown stays within 25 options and pages through long shows',()=>{
  const s=session({episodes:eps(100),episode:57});
  let o=episodeOptions(s);assert(o.length<=25);
  assert(o.some(x=>x.default&&x.label.startsWith('Episode 58')));
  assert(o[0]!.value.startsWith('page:'));assert(o.at(-1)!.value.startsWith('page:'));
  s.epPage=0;o=episodeOptions(s);assert(o[0]!.label.startsWith('Episode 1'));assert(o.at(-1)!.value==='page:1');
  s.epPage=4;o=episodeOptions(s);assert(o.at(-1)!.label.startsWith('Episode 92')||!o.at(-1)!.value.startsWith('page:'));
  assert.equal(episodePage(session({episodes:eps(12)})),0);
  assert.equal(episodeOptions(session({episodes:eps(24)})).length,24);
});
test('seasons are grouped, ordered and numbered from one search',()=>{
  const rows=[t('Dr. Stone: New World',{year:2023}),t('Dr. Stone',{year:2019}),t('Dr. Stone: Stone Wars',{year:2021}),t('Death Note')];
  const fam=buildFamily(rows[1]!,rows);
  assert.deepEqual(fam.map(f=>[f.title,f.season]),[['Dr. Stone',1],['Dr. Stone: Stone Wars',2],['Dr. Stone: New World',3]]);
  const picked=withFamily(rows[2]!,rows);
  assert.equal(picked.season,2);assert.equal(seasonText(picked),'Season 2');
  assert.equal(withFamily(t('Death Note'),rows).family,undefined);
});
test('stated season numbers and specials are respected; hints come from the catalog entries',()=>{
  const rows=[t('Attack on Titan Season 2'),t('Attack on Titan'),t('Attack on Titan Season 3'),t('Attack on Titan: The Movie')];
  const fam=buildFamily(rows[1]!,rows);
  assert.deepEqual(fam.map(f=>[f.title,f.season]),[['Attack on Titan',1],['Attack on Titan Season 2',2],['Attack on Titan Season 3',3],['Attack on Titan: The Movie',0]]);
  assert.equal(seasonText(fam.at(-1)),'Special');
  const catalog=[{...t('Frieren',{provider:'catalog'}),year:2023,count:28},{...t('Frieren Season 2',{provider:'catalog'}),year:2026,count:10}];
  const mixed=buildFamily(t('Frieren'),[t('Frieren'),t('Frieren Season 2')],[...catalog,t('Frieren'),t('Frieren Season 2')]);
  assert.deepEqual(mixed.map(f=>[f.season,f.count]),[[1,28],[2,10]]);
  assert.equal(baseKey('Mob Psycho 100 II'),'mob psycho');assert.equal(explicitSeason('Kaguya-sama 3rd Season'),3);
});
test('season dropdown lists each season with its episode count',()=>{
  const fam=buildFamily(t('Dr. Stone'),[t('Dr. Stone',{year:2019,count:24}),t('Dr. Stone: Stone Wars',{year:2021,count:11})]);
  const s=session({title:{...t('Dr. Stone'),season:1,family:fam}});
  const o=seasonOptions(s);
  assert.equal(o.length,2);assert(o[0]!.default);assert(o[1]!.label.startsWith('Season 2'));assert.equal(o[1]!.description,'11 episodes · 2021');
});
test('playing an episode asks for the chosen quality and records whether 1080p is offered',async()=>{
  const tv:any=new Streaming();tv.session=session({phase:'idle',quality:'720p'});
  tv.prepare=async()=>{};tv.paint=async()=>{};tv.persist=()=>{};let sent:any;
  tv.bridge={call:async(path:string,body?:any)=>{sent=body;return {provider:'hianime',hd:true,streamQuality:'720p'}}};
  await tv.startEpisode(0);
  assert.equal(sent.quality,'720p');assert.equal(tv.session.hd,true);assert.equal(tv.session.quality,'720p');
  tv.session.quality='1080p';tv.bridge={call:async(_p:string,body?:any)=>{sent=body;return {provider:'hianime',hd:true,streamQuality:'1080p'}}};
  await tv.startEpisode(0);assert.equal(sent.quality,'1080p');assert.equal(tv.session.quality,'1080p');
  tv.bridge={call:async()=>({provider:'x',hd:false,streamQuality:'720p'})};
  await tv.startEpisode(0);assert.equal(tv.session.hd,false);assert.equal(tv.session.quality,'720p');
});
