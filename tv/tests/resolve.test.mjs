import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEntity,attachCandidates} from '../src/identity.mjs';
import {verifyEntity} from '../src/resolve.mjs';
import {verifiedPlan,offeredLanguages} from '../src/playback.mjs';

const cat=[
  {id:'catalog:anilist:11061',provider:'catalog',title:'Hunter x Hunter (2011)',aliases:['HUNTER×HUNTER (2011)'],year:2011,format:'TV',status:'FINISHED',numberOfEpisodes:148},
  {id:'catalog:anilist:136',provider:'catalog',title:'Hunter x Hunter',aliases:['HUNTER×HUNTER'],year:1999,format:'TV',status:'FINISHED',numberOfEpisodes:62},
];
const eps=(n,languages)=>Array.from({length:n},(_,i)=>({id:`e${i+1}`,number:i+1,languages}));
// What the providers really answer: anikoto has both series under the same unyeared title; megaplay is keyed by AniList id.
const listings={
  'megaplay:11061':eps(148,['sub','dub']),'megaplay:136':eps(62,['sub','dub']),
  'anikoto:old':eps(62,['sub']),'anikoto:new':eps(148,['sub','dub']),
  'hianime:one':eps(62,['sub']),
};
const list=async(p,id)=>{const r=listings[`${p}:${id}`]||listings[id];if(!r)throw new Error('down');return r};
function world(extra=[]){
  const entities=cat.map(makeEntity);
  attachCandidates(entities,[
    {provider:'megaplay',id:'megaplay:11061',title:'Hunter x Hunter (2011)'},{provider:'megaplay',id:'megaplay:136',title:'Hunter x Hunter'},
    {provider:'anikoto',id:'anikoto:old',title:'Hunter x Hunter'},{provider:'anikoto',id:'anikoto:new',title:'Hunter x Hunter'},
    {provider:'hianime',id:'hianime:one',title:'Hunter x Hunter'},...extra]);
  const byKey=new Map(entities.map(e=>[e.key,e]));
  return {entities,byKey,e11:byKey.get('catalog:anilist:11061'),e99:byKey.get('catalog:anilist:136')};
}

test('2011 only ever gets 148-episode listings and 1999 only 62-episode ones',async()=>{
  const w=world();
  const v11=await verifyEntity(w.e11,{byKey:w.byKey,list}),v99=await verifyEntity(w.e99,{byKey:w.byKey,list});
  assert.deepEqual(v11.accepted.map(r=>r.media).sort(),['anikoto:new','megaplay:11061']);
  assert.deepEqual(v99.accepted.map(r=>r.media).sort(),['anikoto:old','hianime:one','megaplay:136']);
  assert.equal(v11.menu.length,148);assert.equal(v99.menu.length,62);
  assert.ok(v11.rejected.some(r=>r.media==='anikoto:old'&&/62/.test(r.reason)));
  assert.ok(v11.report.some(l=>/REJECT anikoto/.test(l)));
});

test('switching Sub/Dub on the 2011 series cannot land on the 1999 one',async()=>{
  const w=world();const v=await verifyEntity(w.e11,{byKey:w.byKey,list});
  for(const lang of ['sub','dub'])for(const n of [1,62,63,148]){
    const plan=verifiedPlan(v.accepted,{provider:'megaplay',media:'megaplay:11061'},n,lang);
    assert.ok(plan.length>0,`${lang} ${n}`);
    assert.ok(plan.every(p=>['megaplay:11061','anikoto:new'].includes(p.media)),`${lang} ${n}: ${JSON.stringify(plan)}`);
    assert.equal(plan[0].media,'megaplay:11061');
  }
  // On the 1999 series Dub exists only where the verified listings say so
  const v99=await verifyEntity(w.e99,{byKey:w.byKey,list});
  assert.deepEqual(verifiedPlan(v99.accepted,{provider:'megaplay',media:'megaplay:136'},5,'dub').map(p=>p.media),['megaplay:136']);
});

test('a language no verified listing offers gives an empty plan and says what is offered',async()=>{
  const w=world();const v=await verifyEntity(w.e99,{byKey:w.byKey,list:async(p,id)=>id==='megaplay:136'?eps(62,['sub']):list(p,id)});
  assert.deepEqual(verifiedPlan(v.accepted,null,3,'dub'),[]);
  assert.deepEqual(offeredLanguages(v.accepted,3),['sub']);
});

test('a listing that is still loading is pending, never accepted, and makes the menu incomplete',async()=>{
  const w=world();
  const slow=async(p,id)=>{if(id==='anikoto:new')throw new Error('timeout');return list(p,id)};
  const v=await verifyEntity(w.e11,{byKey:w.byKey,list:slow});
  assert.equal(v.pending,1);assert.deepEqual(v.accepted.map(r=>r.media),['megaplay:11061']);
  assert.ok(v.report.some(l=>/PENDING anikoto/.test(l)));
  // dub of an episode only the pending source might have is "unknown", not "not listed"
  assert.notEqual(v.menu[0].availability.dub.status,'not-listed');
});

test('movies of the same franchise are separate entities and keep their own listings',async()=>{
  const entities=[...cat,{id:'catalog:anilist:2742',provider:'catalog',title:'Hunter x Hunter: Phantom Rouge',aliases:[],year:2013,format:'MOVIE',status:'FINISHED',numberOfEpisodes:1}].map(makeEntity);
  attachCandidates(entities,[{provider:'anikoto',id:'anikoto:pr',title:'Hunter x Hunter: Phantom Rouge'},{provider:'anikoto',id:'anikoto:new',title:'Hunter x Hunter'}]);
  const movie=entities.find(e=>e.format==='MOVIE');
  const v=await verifyEntity(movie,{byKey:new Map(entities.map(e=>[e.key,e])),list:async(p,id)=>id==='anikoto:pr'?eps(1,['sub']):list(p,id)});
  assert.deepEqual(v.accepted.map(r=>r.media),['anikoto:pr']);
});
