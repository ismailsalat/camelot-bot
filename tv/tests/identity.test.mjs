import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEntity,attachCandidates,rankEntities,displayTitle,describeEntity,listingStats,verifyCandidate,reportLines} from '../src/identity.mjs';

const hxh2011={id:'catalog:anilist:11061',provider:'catalog',title:'Hunter x Hunter (2011)',aliases:['HUNTER×HUNTER (2011)'],year:2011,format:'TV',status:'FINISHED',numberOfEpisodes:148,popularity:900000};
const hxh1999={id:'catalog:anilist:136',provider:'catalog',title:'Hunter x Hunter',aliases:['HUNTER×HUNTER'],year:1999,format:'TV',status:'FINISHED',numberOfEpisodes:62,popularity:100000};
const phantom={id:'catalog:anilist:2742',provider:'catalog',title:'Hunter x Hunter: Phantom Rouge',aliases:['Gekijouban Hunter x Hunter: Phantom Rouge'],year:2013,format:'MOVIE',status:'FINISHED',numberOfEpisodes:1,popularity:80000};
const lastMission={id:'catalog:anilist:11736',provider:'catalog',title:'Hunter x Hunter: The Last Mission',aliases:[],year:2013,format:'MOVIE',status:'FINISHED',numberOfEpisodes:1,popularity:70000};
const eps=n=>Array.from({length:n},(_,i)=>({id:'e'+i,number:i+1}));
const world=()=>{
  const entities=[hxh1999,hxh2011,phantom,lastMission].map(makeEntity);
  const decisions=attachCandidates(entities,[
    {provider:'megaplay',id:'megaplay:11061',title:'Hunter x Hunter (2011)'},
    {provider:'megaplay',id:'megaplay:136',title:'Hunter x Hunter'},
    {provider:'anikoto',id:'anikoto:aaa',title:'Hunter x Hunter'},            // no year: could be either series
    {provider:'anikoto',id:'anikoto:bbb',title:'Hunter x Hunter (2011)'},     // year in the name
    {provider:'hianime',id:'hianime:ccc',title:'Hunter x Hunter'},
    {provider:'hianime',id:'hianime:ddd',title:'Hunter x Hunter 2011'},
    {provider:'gogoanime',id:'gogoanime:eee',title:'Hunter x Hunter Movie: Phantom Rouge'},
  ]);
  return {entities,decisions,byKey:new Map(entities.map(e=>[e.key,e])),by:k=>entities.find(e=>e.key===k)};
};

test('provider candidates attach by id, by name+year, or are marked ambiguous when two series share the title',()=>{
  const w=world(),e11=w.by(hxh2011.id),e99=w.by(hxh1999.id);
  const conf=e=>Object.fromEntries(e.candidates.map(c=>[c.id,c.confirm]));
  assert.equal(conf(e11)['megaplay:11061'],'id');
  assert.equal(conf(e99)['megaplay:136'],'id');
  assert.equal(conf(e11)['megaplay:136'],undefined);                      // id says 1999: never offered for 2011
  assert.equal(conf(e11)['anikoto:bbb'],'name+year');
  assert.equal(conf(e99)['anikoto:bbb'],undefined);
  assert.equal(conf(e11)['hianime:ddd'],'name+year');
  assert.equal(conf(e11)['anikoto:aaa'],'ambiguous');                     // same title, no year
  assert.equal(conf(e99)['anikoto:aaa'],'ambiguous');
  assert.ok(w.decisions.some(d=>d.provider==='gogoanime'));
});

test('the episode count decides ambiguous listings: the 62-episode one is the 1999 series, never the 2011 one',()=>{
  const w=world(),e11=w.by(hxh2011.id),e99=w.by(hxh1999.id);
  const amb=e=>e.candidates.find(c=>c.id==='anikoto:aaa');
  const old=listingStats(eps(62)),remake=listingStats(eps(148));
  assert.equal(verifyCandidate(e11,amb(e11),old,w.byKey).accept,false);
  assert.match(verifyCandidate(e11,amb(e11),old,w.byKey).reason,/1999|62/);
  assert.equal(verifyCandidate(e99,amb(e99),old,w.byKey).accept,true);
  assert.equal(verifyCandidate(e11,amb(e11),remake,w.byKey).accept,true);
  assert.equal(verifyCandidate(e99,amb(e99),remake,w.byKey).accept,false);
  // a listing that misses a few episodes still belongs to the right series
  assert.equal(verifyCandidate(e11,amb(e11),listingStats(eps(140)),w.byKey).accept,true);
  // neither: refuse rather than guess
  const odd=verifyCandidate(e11,amb(e11),listingStats(eps(20)),w.byKey);
  assert.equal(odd.accept,false);assert.match(odd.reason,/cannot tell/);
});

test('an id-confirmed listing is accepted without counting, and an empty listing is never accepted',()=>{
  const w=world(),e11=w.by(hxh2011.id);
  const mp=e11.candidates.find(c=>c.id==='megaplay:11061');
  assert.equal(verifyCandidate(e11,mp,listingStats(eps(148)),w.byKey).accept,true);
  assert.equal(verifyCandidate(e11,mp,listingStats([]),w.byKey).accept,false);
});

test('search order: the TV series first (2011 before 1999 by popularity), movies after, with the year added to the name',()=>{
  const w=world();
  const order=rankEntities(w.entities.filter(e=>!e.orphan),'hunter x hunter');
  assert.deepEqual(order.map(e=>e.key),[hxh2011.id,hxh1999.id,phantom.id,lastMission.id]);
  assert.equal(displayTitle(w.by(hxh1999.id),w.entities),'Hunter x Hunter (1999)');
  assert.equal(displayTitle(w.by(hxh2011.id),w.entities),'Hunter x Hunter (2011)');
  assert.match(describeEntity(w.by(hxh2011.id)),/^TV · 2011 · 148 eps · \d sources?$/);
  assert.match(describeEntity(w.by(phantom.id)),/^Movie · 2013 · 1 ep/);
});

test('a single-version show needs no disambiguation, but an absurd listing is still refused',()=>{
  const e=makeEntity({id:'catalog:anilist:1',title:'Dr. Stone',year:2019,format:'TV',status:'FINISHED',numberOfEpisodes:24});
  attachCandidates([e],[{provider:'hianime',id:'hianime:x',title:'Dr. Stone'}]);
  const c=e.candidates[0];
  assert.equal(c.confirm,'name');
  assert.equal(verifyCandidate(e,c,listingStats(eps(24)),new Map()).accept,true);
  assert.equal(verifyCandidate(e,c,listingStats(eps(4)),new Map()).accept,false);
});

test('without a catalogue, titles with different years still become different entities',()=>{
  const entities=[];
  attachCandidates(entities,[{provider:'a',id:'a:1',title:'Fruits Basket (2001)'},{provider:'b',id:'b:1',title:'Fruits Basket (2019)'},{provider:'c',id:'c:1',title:'Fruits Basket 2019'}]);
  assert.equal(entities.length,2);
  assert.equal(entities.find(e=>e.year===2019).candidates.length,2);
});

test('the match report is one readable line per decision',()=>{
  const w=world(),e11=w.by(hxh2011.id);
  const lines=reportLines(e11,[verifyCandidate(e11,e11.candidates.find(c=>c.id==='anikoto:aaa'),listingStats(eps(62)),w.byKey)]);
  assert.match(lines[0],/Match report for "Hunter x Hunter \(2011\)".*148 eps/);
  assert.match(lines[1],/REJECT anikoto.*62 eps/);
});
import {searchRows} from '../src/identity.mjs';
test('picker rows: both Hunter x Hunter series appear once each with their year, movies after, every row says what it is',()=>{
  const w=world();
  const rows=searchRows(w.entities,'hunter x hunter',20).map(x=>x.row);
  assert.deepEqual(rows.map(r=>r.title).slice(0,4),['Hunter x Hunter (2011)','Hunter x Hunter (1999)','Hunter x Hunter: Phantom Rouge','Hunter x Hunter: The Last Mission']);
  assert.equal(new Set(rows.map(r=>r.entity)).size,rows.length);
  const r11=rows[0],r99=rows[1];
  assert.equal(r11.id,'catalog:anilist:11061');assert.equal(r99.id,'catalog:anilist:136');
  assert.match(r11.description,/^TV · 2011 · 148 eps/);assert.match(r99.description,/^TV · 1999 · 62 eps/);
  assert.ok(r11.sources.includes('megaplay')&&r99.sources.includes('megaplay'));
  assert.equal(rows.find(r=>r.format==='MOVIE').group,'movie');
});
