import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {unpackMegaPlaySources,megaPlayEmbedFor,resolveMegaPlayV2} from '../src/megaplay-v2.mjs';
function encrypt(obj){
 const key=Buffer.alloc(32);Buffer.from('i?LMTAx0Q6,:}50U').copy(key);
 const cipher=createCipheriv('aes-256-cbc',key,Buffer.from("W0;27ToaUpl_P%'c"));
 return Buffer.concat([cipher.update(JSON.stringify(obj)),cipher.final()]).toString('base64url');
}
test('old plaintext and new encoded source formats resolve identically',()=>{
 const file='https://videos.example.com/ep1.m3u8?token=abcdef';
 assert.equal(unpackMegaPlaySources({sources:{file}}).file,file);
 assert.equal(unpackMegaPlaySources({enc:encrypt({file})}).file,file);
});
test('bad responses fail closed with no raw payload in error',()=>{
 assert.throws(()=>unpackMegaPlaySources({enc:'garbage'}),/changed its source response/);
 assert.throws(()=>unpackMegaPlaySources({}),/did not provide/);
});
test('only exact provider/episode identifiers create public MegaPlay embed paths',()=>{
 assert.equal(megaPlayEmbedFor('megaplay','megaplay:123:1','sub'),'https://megaplay.buzz/stream/ani/123/1/sub');
 assert.equal(megaPlayEmbedFor('anikoto','anikoto:123_AB','dub'),'https://megaplay.buzz/stream/s-2/123_AB/dub');
 assert.throws(()=>megaPlayEmbedFor('anikoto','anikoto:../../etc/passwd'),/Invalid/);
});
test('updated player requests getSourcesNew and returns HTTPS source with allowed headers',async()=>{
 let calls=[];
 const http={get:async(url,args)=>{calls.push({url,args});if(url.includes('getSourcesNew'))return {ok:true,json:async()=>({enc:encrypt({file:'https://example.org/123.m3u8'})})};return {ok:true,text:async()=>'<title>File 7777 - MegaPlay</title>'}}};
 const data=await resolveMegaPlayV2('megaplay','megaplay:999:1','sub',http);
 assert.equal(data[0].sourceUrl,'https://example.org/123.m3u8');
 assert.equal(data[0].isHLS,true);
 assert.equal(calls[1].url,'https://megaplay.buzz/stream/getSourcesNew?id=7777');
 assert.equal(data[0].headers.Referer,'https://megaplay.buzz/');
});
