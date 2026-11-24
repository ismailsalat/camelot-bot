import test from 'node:test';
import assert from 'node:assert/strict';
import {extractMegaPlayFileId,unpackMegaPlaySources,resolveMegaPlayV2} from '../src/megaplay-v2.mjs';

test('read player file ID from dynamically ordered embed attributes',()=>{
 assert.equal(extractMegaPlayFileId('<div data-realid="987" id="megaplay-player"></div>'),'987');
 assert.equal(extractMegaPlayFileId('<div id="megaplay-player" data-id="321"></div>'),'321');
 assert.equal(extractMegaPlayFileId('<title>File 456 - MegaPlay</title>'),'456');
});
test('source list as object or array, legacy and nested response',()=>{
 assert.equal(unpackMegaPlaySources({sources:[{file:'https://cdn.test/ep.m3u8'}]}).file,'https://cdn.test/ep.m3u8');
 assert.equal(unpackMegaPlaySources({data:{sources:{file:'https://cdn.test/ep.m3u8'}}}).file,'https://cdn.test/ep.m3u8');
});
test('falls back to legacy player endpoint when newer response has no video source',async()=>{
 let calls=[];
 const http={get:async(url)=>{calls.push(url);if(url.includes('getSourcesNew'))return {ok:true,status:200,json:async()=>({})};if(url.includes('getSources'))return {ok:true,status:200,json:async()=>({sources:[{file:'https://video.example.com/episode.mp4'}]})};return {ok:true,status:200,text:async()=>'<div id="megaplay-player" data-id="777"></div>'}}};
 const streams=await resolveMegaPlayV2('anikoto','anikoto:EXAMPLE123','sub',http);
 assert.equal(streams[0].sourceUrl,'https://video.example.com/episode.mp4');
 assert.deepEqual(calls.slice(1).map(x=>new URL(x).pathname),['/stream/getSourcesNew','/stream/getSources']);
});
test('does not retry an access-denied/rate-limited source host',async()=>{
 let calls=[];
 const http={get:async(url)=>{calls.push(url);return calls.length===1?{ok:true,status:200,text:async()=>'<title>File 999 - MegaPlay</title>'}:{ok:false,status:429}}};
 await assert.rejects(()=>resolveMegaPlayV2('megaplay','megaplay:123:1','sub',http),/429/);
 assert.equal(calls.length,2);
});
test('refuses untrusted media returned by source API',async()=>{
 const http={get:async(url)=>url.includes('getSources')?{ok:true,status:200,json:async()=>({sources:{file:'http://127.0.0.1/admin'}})}:{ok:true,status:200,text:async()=>'<title>File 999 - MegaPlay</title>'}};
 await assert.rejects(()=>resolveMegaPlayV2('megaplay','megaplay:123:1','sub',http),/endpoints unavailable/);
});
