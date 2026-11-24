import test from 'node:test';import assert from 'node:assert/strict';
import {parseSearch,parseEpisodes,decodePlayer} from '../src/hianime.mjs';
test('current HiAnime search preserves exact title and season id',()=>{
 const rows=parseSearch('<h3 class="film-name"><a href="/dr-stone-175" title="Dr. STONE">Dr. STONE</a></h3>');
 assert.equal(rows[0].id,'hianime:dr-stone-175');assert.equal(rows[0].title,'Dr. STONE');
});
test('episode parser handles JSON HTML response and never fabricates language availability',()=>{
 const rows=parseEpisodes(JSON.stringify({html:'<a class="ep-item" data-number="2" data-id="345" href="/watch/dr-stone-175?ep=345" title="King of the Stone World">'}),'dr-stone-175');
 assert.deepEqual(rows,[{id:'hianime:ep:345',number:2,title:'King of the Stone World',availableLanguages:[]}]);
});
test('player config decoder returns JSON and rejects malformed config',()=>{
 const config={src:'https://cdn.example.org/master.m3u8'},key=Buffer.from('otaku-embed-v1');
 const blob=Buffer.from(JSON.stringify(config)).map((x,i)=>x^key[i%key.length]).toString('base64');
 assert.deepEqual(decodePlayer(blob),config);assert.throws(()=>decodePlayer('bad'));
});
