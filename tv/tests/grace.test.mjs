import test from 'node:test';
import assert from 'node:assert/strict';
import {settleWithGrace} from '../src/grace.mjs';
import {inspectSources} from '../src/availability.mjs';
const sleep=(ms,v,fail)=>new Promise((res,rej)=>setTimeout(()=>fail?rej(new Error('x')):res(v),ms));
test('slow sources no longer decide the wait once one has answered',async()=>{
  const t0=Date.now();
  const out=await settleWithGrace([sleep(20,['a']),sleep(5000,['b'])],{graceMs:80,isGood:r=>r.length>0});
  assert(Date.now()-t0<1000);
  assert.equal(out[0].status,'fulfilled');assert.equal(out[1].status,'rejected');
});
test('without a good answer it still waits for everyone',async()=>{
  const out=await settleWithGrace([sleep(10,[]),sleep(60,['b'])],{graceMs:20,isGood:r=>r.length>0});
  assert.equal(out[1].status,'fulfilled');
});
test('zero grace keeps the old wait-for-all behaviour',async()=>{
  const out=await settleWithGrace([sleep(10,1),sleep(50,2,true)]);
  assert.deepEqual(out.map(x=>x.status),['fulfilled','rejected']);
});
test('inspectSources returns after the grace window and marks stragglers unavailable',async()=>{
  const original={provider:'catalog',id:'c',title:'Dr. Stone'};
  const cands=[{provider:'hianime',id:'hianime:1',title:'Dr. Stone'},{provider:'allmanga',id:'allmanga:2',title:'Dr. Stone'}];
  const list=async p=>p==='hianime'?[{id:'e1',number:1,languages:['sub']}]:sleep(5000,[]);
  const t0=Date.now();
  const rows=await inspectSources(original,cands,list,{graceMs:60});
  assert(Date.now()-t0<1500);
  assert.equal(rows.find(r=>r.provider==='hianime').status,'checked');
  assert.equal(rows.find(r=>r.provider==='allmanga').status,'unavailable');
});
