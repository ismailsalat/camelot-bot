import test from 'node:test';
import assert from 'node:assert/strict';
import {CamelotTVClient} from '../integration/camelot_tv_client.mjs';
test('bridge client binds commands to its server and passes audio/captions explicitly',async()=>{
 const calls=[];
 const client=new CamelotTVClient({baseUrl:'http://localhost:3333',apiKey:'k'.repeat(40),guildId:'123456789012345678',fetcher:async(url,options)=>{calls.push({url,options});return new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}});}});
 await client.play({provider:'animeparadise',id:'animeparadise:stone'},{id:'episode:1'},{channel:'234567890123456789',audio:'dub',subtitles:'en'});
 const body=JSON.parse(calls[0].options.body);assert.equal(body.guild,'123456789012345678');assert.equal(body.lang,'dub');assert.equal(body.subtitles,'en');assert.equal(calls[0].options.redirect,'error');
 await client.stop();assert.equal(JSON.parse(calls[1].options.body).guild,body.guild);
});
test('bridge refuses insecure remote transport and credentials embedded in URL',()=>{
 for(const baseUrl of ['http://example.com','https://user:secret@example.com'])assert.throws(()=>new CamelotTVClient({baseUrl,apiKey:'k'.repeat(40),guildId:'123456789012345678'}));
});
