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
 assert.deepEqual(rows[0].components.map((b:any)=>b.label),['Previous','Pause','Next','Stop']);
 assert(rows[0].components[0].disabled);assert(!rows[0].components[2].disabled);
 assert.equal(rows[1].components[0].custom_id,'tv:abc:seek');
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
   deferReply:async function(){this.deferred=true},deleteReply:async function(){this.deleted=true},editReply:async()=>{},reply:async()=>{}} as any;
 assert(await tv.handle(interaction));
 assert.equal(tv.session.episode,1);assert.equal(tv.session.owner,'alice');
 assert.equal(calls.find(c=>c[0]==='/api/play')[1].unit,'e2');
 assert.equal(calls.filter(c=>c[0].startsWith('/api/search')).length,0);
});

import {renderHelpHome,renderHelpCategory} from '../core/help.js';
import {streamingHealth} from '../core/status.js';
import {settingsCard} from '../streaming/ui.js';
import {clearToken,tokenSource} from '../streaming/store.js';

test('Help includes /help and Streaming setup even while Streaming is off',()=>{
 const m=member('alice');const home=JSON.stringify(renderHelpHome(m).toJSON());
 assert(home.includes('/help'));assert(home.includes('/stream'));assert(home.includes('Streaming · Off'));
 const detail=JSON.stringify(renderHelpCategory(m,'streaming').toJSON());
 assert(detail.includes('Turn it on')||detail.includes('turn it on'));assert(detail.includes('My turn'));assert(detail.includes('Stop'));
 assert(!JSON.stringify(renderHelpCategory(m,'purge').toJSON()).includes('Runs on its own'));
});
test('Streaming status distinguishes disabled, missing, valid and unreadable account',()=>{
 const guild=member('alice').guild;
 assert.equal(streamingHealth(guild)[0]!.state,'off');
 setByPath('guild','modules.streaming',true);assert.equal(streamingHealth(guild)[0]!.state,'warn');
 saveToken('guild','a'.repeat(60));assert.equal(streamingHealth(guild)[0]!.state,'ok');
 const previous=process.env.STREAMING_SECRET_KEY;process.env.STREAMING_SECRET_KEY='cd'.repeat(32);
 try{assert.equal(streamingHealth(guild)[0]!.state,'warn')}finally{process.env.STREAMING_SECRET_KEY=previous}
});
test('settings show saved account without displaying its token',()=>{
 const token='x'.repeat(60);saveToken('guild',token);
 const card=JSON.stringify(settingsCard(member('owner')).toJSON());
 assert(card.includes('Saved in Settings'));assert(card.includes('Check account'));assert(!card.includes(token));assert(card.includes('empty token form'));
});
test('removing a saved account reports the environment fallback accurately',()=>{
 const oldToken=process.env.CAMELOT_STREAMER_TOKEN,oldGuild=process.env.CAMELOT_GUILD_ID;
 process.env.CAMELOT_STREAMER_TOKEN='z'.repeat(60);process.env.CAMELOT_GUILD_ID='guild';
 try{saveToken('guild','x'.repeat(60));clearToken('guild');assert.equal(tokenSource('guild'),'Railway variable');assert.equal(getToken('guild'),'z'.repeat(60))}
 finally{if(oldToken===undefined)delete process.env.CAMELOT_STREAMER_TOKEN;else process.env.CAMELOT_STREAMER_TOKEN=oldToken;if(oldGuild===undefined)delete process.env.CAMELOT_GUILD_ID;else process.env.CAMELOT_GUILD_ID=oldGuild}
});
test('malformed persisted session cannot crash startup',()=>{
 saveSession(fixture());getDb().prepare('UPDATE streaming_state SET value=? WHERE key=?').run('{"episodes":"bad"}','session');
 assert.equal(restoreSession(),null);
});
test('loading disables playback changes but keeps Stop available',()=>{
 const s=fixture();s.phase='loading';const rows=panel(s,0).toJSON().components.filter((x:any)=>x.type===1) as any[];
 assert(rows[0].components[1].disabled);assert(!rows[0].components[3].disabled);assert(rows[1].components.slice(0,3).every((x:any)=>x.disabled));
});
test('gate idle waits for completion even after the operation rejects',async()=>{
 const gate=new Gate();let finish!:()=>void;let idle=false;
 const first=gate.run(async()=>{await new Promise<void>(r=>finish=r);throw Error('cancelled')});
 const handled=assert.rejects(first,/cancelled/);const waiting=gate.idle().then(()=>{idle=true});
 await Promise.resolve();assert(!idle);finish();await handled;await waiting;assert(idle);
});
function interaction(op:string,user='alice'){
 const replies:any[]=[];
 return {customId:`tv:abc:${op}`,isChatInputCommand:()=>false,isRepliable:()=>true,inCachedGuild:()=>true,member:member(user),isButton:()=>true,isModalSubmit:()=>false,isStringSelectMenu:()=>false,deferred:false,replied:false,replies,
 deferReply:async function(){this.deferred=true},deleteReply:async function(){this.deleted=true},editReply:async(p:any)=>{replies.push(p)},reply:async(p:any)=>{replies.push(p)}} as any;
}
test('unauthorized click during loading never changes the active stream to error',async()=>{
 const tv:any=new Streaming();tv.session=fixture();tv.session.phase='loading';setByPath('guild','modules.streaming',true);
 let failed=false;tv.fail=async()=>{failed=true};const i=interaction('next','bob');await tv.handle(i);
 assert(!failed);assert.equal(tv.session.phase,'loading');assert(i.replies[0].content.includes('Only the controller'));
});
test('temporary message fetch failure keeps the panel and is retried',async()=>{
 const tv:any=new Streaming();tv.session=fixture();tv.session.message='old';let sent=0,edits=0,fail=true;
 tv.channel=async()=>({messages:{fetch:async()=>{if(fail)throw Error('temporary');return {attachments:new Collection(),edit:async()=>{edits++}}}},send:async()=>{sent++;return{id:'new'}}});
 await tv.paint();assert.equal(tv.session.message,'old');assert(tv.dirty);assert.equal(sent,0);
 fail=false;await tv.paint();assert.equal(edits,1);assert(!tv.dirty);
});
test('a change requested during a panel update is painted afterward',async()=>{
 const tv:any=new Streaming();tv.session=fixture();tv.session.message='old';let finish!:()=>void;let edits=0;
 tv.channel=async()=>({messages:{fetch:async()=>({attachments:new Collection(),edit:async()=>{edits++;if(edits===1)await new Promise<void>(r=>finish=r)}})}});
 const first=tv.paint();while(!finish)await new Promise(r=>setImmediate(r));
 tv.session.note='New state';const second=tv.paint();finish();await Promise.all([first,second]);assert.equal(edits,2);
});
test('Stop cancels the running operation before releasing and blocks new claims meanwhile',async()=>{
 const tv:any=new Streaming();tv.session=fixture();setByPath('guild','modules.streaming',true);tv.paint=async()=>{};
 let finish!:()=>void;const order:string[]=[];
 const running=tv.gate.run(async()=>{await new Promise<void>(r=>finish=r);order.push('operation ended')});
 tv.bridge={cancelRequests:()=>{order.push('cancel');finish()},close:async()=>{order.push('close')},disconnect:async()=>{assert(!tv.gate.locked||tv.stopping);order.push('disconnect')}};
 const i=interaction('stop');await tv.handle(i);await running;
 assert.equal(tv.session.owner,null);assert(order.indexOf('operation ended')<order.indexOf('disconnect'));assert(!tv.stopping);
 assert(i.replies.at(-1).content.includes('stopped'));
});
test('seek uses fresh worker position and reports success only after acknowledgment',async()=>{
 const tv:any=new Streaming();tv.session=fixture();setByPath('guild','modules.streaming',true);tv.paint=async()=>{};
 let finish!:()=>void;let target=0;
 tv.bridge={call:async(path:string,body:any)=>{if(path==='/api/state')return{status:'streaming',position:60,duration:120};target=body.position;await new Promise<void>(r=>finish=r)}};
 const i=interaction('seekInput');i.isButton=()=>false;i.isModalSubmit=()=>true;i.fields={getTextInputValue:()=>'+30'};
 const pending=tv.handle(i);while(!finish)await new Promise(r=>setImmediate(r));
 assert.equal(i.replies.length,0);assert.equal(target,90);finish();await pending;assert.equal(tv.session.position,90);assert(i.deleted);assert.equal(i.replies.length,0);
});
