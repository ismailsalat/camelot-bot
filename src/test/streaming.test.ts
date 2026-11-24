import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDatabase,getDb} from '../db/index.js';
import {setByPath,clearSettingsCache} from '../db/settings.js';
import {Gate,seconds,boundedPosition,type Session} from '../streaming/model.js';
import {saveToken,getToken,hasToken,saveSession,restoreSession} from '../streaming/store.js';
import {panel} from '../streaming/ui.js';
import {Streaming} from '../streaming/service.js';
import {ChannelType,Collection} from 'discord.js';
process.env.STREAMING_SECRET_KEY='ab'.repeat(32);
const fixture=():Session=>({id:'abc',guild:'guild',channel:'voice',owner:'alice',episodes:[{id:'e1',number:1,title:'One'},{id:'e2',number:2,title:'Two'}],episode:0,title:{id:'show',provider:'p',title:'A title'},sources:['p','q'],source:'auto',lang:'dub',phase:'playing',position:30,duration:120,changed:Date.now(),note:''});
beforeEach(()=>{openTestDatabase();clearSettingsCache()});
test('seek input supports absolute and relative times, rejects malformed values',()=>{
 assert.equal(seconds('1:02:03'),3723);assert.equal(seconds('+30',45),75);assert.equal(seconds('-00:30',45),15);
 for(const v of ['NaN','Infinity','-x','1:60','2.2','1e5','1:12:90'])assert.throws(()=>seconds(v));
});
test('seeking never crosses either end or guesses an unknown duration',()=>{
 assert.equal(boundedPosition(119,120),119);
 for(const v of [-1,120,NaN,Infinity])assert.throws(()=>boundedPosition(v,120));
 assert.throws(()=>boundedPosition(1,null));
});
test('session mutation rejects overlapping clicks and recovers after a failure',async()=>{
 const gate=new Gate();let finish!:()=>void;
 const first=gate.run(()=>new Promise<void>(r=>finish=r));
 await assert.rejects(gate.run(async()=>42),/finishing/);finish();await first;
 await assert.rejects(gate.run(async()=>{throw Error('failure')}));
 assert.equal(await gate.run(async()=>42),42);
});
test('token is encrypted, survives retrieval, and is bound to the server',()=>{
 const token='a'.repeat(60);saveToken('one',token);assert.equal(getToken('one'),token);assert(hasToken('one'));
 const db=getDb();const row=db.prepare('SELECT value FROM streaming_state WHERE key=?').get('token:one') as any;
 assert(!row.value.includes(token));
 db.prepare('INSERT INTO streaming_state VALUES (?,?)').run('token:two',row.value);
 assert.throws(()=>getToken('two'),/cannot be opened/);
});
test('invalid replacement does not erase a saved token',()=>{
 saveToken('one','x'.repeat(60));assert.throws(()=>saveToken('one',''));
 assert.equal(getToken('one'),'x'.repeat(60));
});
test('session persists title, episode and position for restart recovery',()=>{
 const s=fixture();saveSession(s);assert.deepEqual(restoreSession(),s);
});
test('panel fits Discord row limits and keeps exact durable action ids',()=>{
 const s=fixture();const json=panel(s,2).toJSON();
 const rows=json.components.filter((c:any)=>c.type===1) as any[];
 assert(rows.every(r=>r.components.length<=5));
 assert.deepEqual(rows[0].components.map((b:any)=>b.label),['Previous ep','Next ep','Stop','Pause']);
 assert(rows[0].components[0].disabled);assert(!rows[0].components[1].disabled);
 assert.equal(rows[1].components[2].custom_id,'tv:abc:seek');
 s.duration=null;const unknown=panel(s,0).toJSON();
 const seek=(unknown.components.filter((c:any)=>c.type===1) as any[])[1];assert(seek.components[0].disabled);
});
function member(id:string,channel='voice',guild='guild'){
 return {id,voice:{channelId:channel,channel:{id:channel,type:ChannelType.GuildVoice,permissionsFor:()=>({has:()=>true})}},guild:{id:guild,ownerId:'owner',members:{me:{}}},permissions:{has:()=>false},roles:{cache:new Collection()}} as any;
}
test('active session cannot be moved by another requester',async()=>{
 const tv:any=new Streaming();tv.session=fixture();setByPath('guild','modules.streaming',true);
 await assert.rejects(tv.claim(member('bob','elsewhere')),/busy/);
 assert.equal(tv.session.channel,'voice');assert.equal(tv.session.owner,'alice');
});
test('viewer cannot take controls or control from another voice channel',()=>{
 const tv:any=new Streaming();tv.session=fixture();
 assert.throws(()=>tv.controller(member('bob')),/Only the controller/);
 assert.throws(()=>tv.controller(member('alice','elsewhere')),/Join the active/);
 assert.doesNotThrow(()=>tv.controller(member('alice')));
});
test('module disable rejects new claims',async()=>{
 const tv:any=new Streaming();await assert.rejects(tv.claim(member('alice')),/turned off/);
});
test('failed replacement send preserves old panel',async()=>{
 const tv:any=new Streaming();tv.session=fixture();tv.session.message='old';tv.bump=true;
 let deleted=false;
 tv.channel=async()=>({messages:{fetch:async()=>({delete:async()=>{deleted=true}})},send:async()=>{throw Error('no permission')}});
 await tv.paint();assert(!deleted);assert.equal(tv.session.message,'old');
});
test('bottom repost deletes only the prior bot panel after successful send',async()=>{
 const tv:any=new Streaming();tv.session=fixture();tv.session.message='old';tv.bump=true;
 const events:string[]=[];
 tv.channel=async()=>({messages:{fetch:async()=>({delete:async()=>events.push('delete')})},send:async()=>{events.push('send');return {id:'new'}}});
 await tv.paint();assert.deepEqual(events,['send','delete']);assert.equal(tv.session.message,'new');
});
test('release finishes worker disconnect before freeing the session',async()=>{
 const tv:any=new Streaming();tv.session=fixture();tv.paint=async()=>{};
 const calls:string[]=[];tv.bridge={disconnect:async()=>{assert.equal(tv.session.owner,'alice');calls.push('/api/stop','/api/disconnect')}};
 await tv.release();assert.deepEqual(calls,['/api/stop','/api/disconnect']);assert.equal(tv.session.owner,null);
});
test('queue hands off only to a requester still in the chosen voice channel',async()=>{
 const tv:any=new Streaming();tv.session=fixture();tv.paint=async()=>{};tv.bridge={disconnect:async()=>{}};
 const alice=member('next','newvc');setByPath('guild','modules.streaming',true);saveToken('guild','a'.repeat(60));
 tv.queue=[{guild:'guild',user:'gone',channel:'oldvc'},{guild:'guild',user:'next',channel:'newvc'}];
 tv.client={guilds:{cache:new Map([['guild',{members:{fetch:async(id:string)=>id==='gone'?null:alice}}]])}};
 await tv.release();assert.equal(tv.session.owner,'next');assert.equal(tv.session.channel,'newvc');assert.equal(tv.queue.length,0);
});
test('Next changes the episode, asks worker for the new episode, and keeps its owner',async()=>{
 const tv:any=new Streaming();tv.session=fixture();setByPath('guild','modules.streaming',true);
 saveToken('guild','a'.repeat(60));tv.paint=async()=>{};
 const calls:any[]=[];tv.bridge={connect:async()=>{},call:async(path:string,body:any)=>{
   calls.push([path,body]);
   if(path==='/api/state')return {streamerId:'streamer'};
   if(path.startsWith('/api/episodes'))return {sources:[{provider:'p',status:'checked'}],episodes:fixture().episodes};
   if(path==='/api/play')return {provider:'p'};
   throw Error('unexpected '+path);
 }};
 const interaction={customId:'tv:abc:next',isChatInputCommand:()=>false,isRepliable:()=>true,inCachedGuild:()=>true,member:member('alice'),isButton:()=>true,isModalSubmit:()=>false,isStringSelectMenu:()=>false,deferred:false,replied:false,
   deferReply:async function(){this.deferred=true},editReply:async()=>{},reply:async()=>{}} as any;
 assert(await tv.handle(interaction));
 assert.equal(tv.session.episode,1);assert.equal(tv.session.owner,'alice');
 assert.equal(calls.find(c=>c[0]==='/api/play')[1].unit,'e2');
 assert.equal(calls.filter(c=>c[0].startsWith('/api/search')).length,0);
});
