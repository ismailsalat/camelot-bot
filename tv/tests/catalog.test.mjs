import test from 'node:test';
import assert from 'node:assert/strict';
import {searchAnimeCatalog,sameAnime} from '../src/catalog.mjs';
test('AniList search produces metadata-only titles',async()=>{
  const fetched=[];const r=await searchAnimeCatalog('black clover',{fetcher:async(url,opts)=>{
    fetched.push(url);return {ok:true,json:async()=>({data:{Page:{media:[{id:345,title:{english:'Black Clover',romaji:'Black Clover'},seasonYear:2017,episodes:170}]}}})};
  }});
  assert.equal(r.results[0].title,'Black Clover');assert.equal(r.results[0].provider,'catalog');
  assert.equal(r.results[0].availability,'catalog-only');assert.equal(r.results[0].id,'catalog:anilist:345');
  assert.equal(fetched[0],'https://graphql.anilist.co');
});
test('AniList unavailable falls back to Jikan',async()=>{
  const r=await searchAnimeCatalog('black clover',{fetcher:async url=>{
    if(url.includes('anilist'))throw new Error('offline');
    return {ok:true,json:async()=>({data:[{mal_id:345,title:'Black Clover',year:2017}]})};
  }});
  assert.equal(r.source,'Jikan');assert.equal(r.results[0].title,'Black Clover');
});
test('exact match prevents different anime and seasons',()=>{
  const c={title:'Black Clover',aliases:['Black Clover'],year:2017};
  assert.ok(sameAnime(c,{title:'Black Clover',year:2017}));
  assert.ok(!sameAnime(c,{title:'Black Clover: Sword of the Wizard King',year:2023}));
  assert.ok(!sameAnime(c,{title:'Black Clover',year:2026}));
});
test('both catalogs fail gracefully, no fake anime',async()=>{
  const r=await searchAnimeCatalog('Frieren',{fetcher:async()=>({ok:false,status:429})});
  assert.equal(r.results.length,0);assert.equal(r.errors.length,2);
});
