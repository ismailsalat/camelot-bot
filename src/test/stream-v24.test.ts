import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildFamily,withFamily} from '../streaming/seasons.js';
import {seasonOptions,panel} from '../streaming/ui.js';
import type {Title,Session} from '../streaming/model.js';

const row=(id:string,title:string,extra:Partial<Title>={}):Title=>({id,provider:'catalog',title,...extra});
const hxh=[
  row('catalog:anilist:11061','Hunter x Hunter (2011)',{year:2011,count:148,format:'TV'}),
  row('catalog:anilist:136','Hunter x Hunter (1999)',{year:1999,count:62,format:'TV'}),
  row('catalog:anilist:2742','Hunter x Hunter: Phantom Rouge',{year:2013,count:1,format:'MOVIE'}),
  row('catalog:anilist:11736','Hunter x Hunter: The Last Mission',{year:2013,count:1,format:'MOVIE'}),
];

test('1999 and 2011 Hunter x Hunter are two shows, never season 1 and season 2',()=>{
  const f=buildFamily(hxh[0]!,hxh);
  assert.ok(!f.some(t=>t.id==='catalog:anilist:136'),'1999 must not be a season of 2011');
  assert.deepEqual(f.filter(t=>t.season!==0).map(t=>t.id),['catalog:anilist:11061']);
  const old=buildFamily(hxh[1]!,hxh);
  assert.ok(!old.some(t=>t.id==='catalog:anilist:11061'));
});

test('movies are specials (season 0) even though their names start the same way',()=>{
  const f=buildFamily(hxh[0]!,hxh);
  assert.deepEqual(f.filter(t=>t.season===0).map(t=>t.title).sort(),['Hunter x Hunter: Phantom Rouge','Hunter x Hunter: The Last Mission']);
  const m=[row('1','Odd Show: The Final Act',{format:'MOVIE'}),row('2','Odd Show',{format:'TV',year:2020})];
  assert.equal(buildFamily(m[1]!,m).find(t=>t.id==='1')?.season,0);
});

test('real seasons still group: Dr. Stone and its sequels',()=>{
  const rows=[row('a','Dr. Stone',{year:2019,format:'TV'}),row('b','Dr. Stone: Stone Wars',{year:2021,format:'TV'}),row('c','Dr. Stone: New World',{year:2023,format:'TV'})];
  const f=withFamily(rows[0]!,rows).family!;
  assert.deepEqual(f.map(t=>t.season),[1,2,3]);
});

test('the panel says whether subtitles are burned in',()=>{
  const s={id:'s',guild:'g',channel:'c',owner:'u',title:{id:'x',provider:'megaplay',title:'Hunter x Hunter (2011)'},episodes:[{id:'episode:1',number:1,title:'Episode 1'}],episode:0,sources:['megaplay'],source:'auto',
    lang:'sub',phase:'playing',position:5,duration:1400,changed:Date.now(),note:'',subtitle:'EN subtitles'} as Session;
  const text=JSON.stringify(panel(s,0));
  assert.match(text,/SUB · EN subtitles/);
  s.subtitle='no subtitles';assert.match(JSON.stringify(panel(s,0)),/SUB · no subtitles/);
  s.lang='dub';s.subtitle='';assert.ok(!/subtitles/.test(JSON.stringify(panel(s,0))));
});
