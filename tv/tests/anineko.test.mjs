import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAniNekoSearch,parseAniNekoEpisodes,parseAniNekoEmbeds,parseAniNekoHLS} from '../src/anineko.mjs';
test('search extracts provider title and its slug; no fake results',()=>{
 const html='<a class="nv-anime-thumb" href="/watch/dr-stone"><h3>Dr. STONE</h3></a><a class="nv-anime-thumb" href="/watch/dr-stone"><h3>Duplicate</h3></a>';
 assert.deepEqual(parseAniNekoSearch(html).map(x=>x.id),['anineko:dr-stone']);
 assert.equal(parseAniNekoSearch('not found').length,0);
});
test('episode numbers and language come from actual listed episodes',()=>{
 const html='<article class="nv-info-episode-item"><a href="/watch/dr-stone/ep-2" class="nv-info-episode-main"><span>King of the Stone World</span></a><span>Sub</span></article><article class="nv-info-episode-item"><a href="/watch/dr-stone/ep-1" class="nv-info-episode-main"><span>Stone World</span></a><span>Sub</span><span>Dub</span></article>';
 const eps=parseAniNekoEpisodes(html,'dr-stone');
 assert.equal(eps.length,2);assert.equal(eps[0].number,1);assert.deepEqual(eps[0].availableLanguages,['sub','dub']);
});
test('never use HTML embed as stream, require direct HLS URL',()=>{
 const html='<div class="nv-server-grid" data-id="sub"><button data-video="https://player.example/video"></button></div><div class="nv-server-grid" data-id="dub"><button data-video="https://other.example/video"></button></div>';
 assert.deepEqual(parseAniNekoEmbeds(html,'sub'),['https://player.example/video']);
 assert.equal(parseAniNekoHLS('<iframe src="https://player.example"></iframe>'),null);
 assert.equal(parseAniNekoHLS('const src = "https://cdn.example/master.m3u8?abc=1";'),'https://cdn.example/master.m3u8?abc=1');
});
