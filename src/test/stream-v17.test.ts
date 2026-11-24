import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {ChannelType,Collection} from 'discord.js';
import {openTestDatabase} from '../db/index.js';
import {setByPath,clearSettingsCache} from '../db/settings.js';
import {saveToken} from '../streaming/store.js';
import {type Session,type Title} from '../streaming/model.js';
import {Streaming} from '../streaming/service.js';
import {panel} from '../streaming/ui.js';
import {MAX_QUEUE,addToQueue,hasPanelControls,queueView,removeFromQueue,takeNext,upNext} from '../streaming/queue.js';
process.env.STREAMING_SECRET_KEY='ab'.repeat(32);
const t=(n:number):Title=>({id:'id'+n,provider:'p',title:'Show '+n});
const fixture=(over:Partial<Session>={}):Session=>({id:'aaaaaaaaaaaa',guild:'guild',channel:'voice',owner:'alice',message:'new',episodes:[{id:'e1',number:1,title:'One'},{id:'e2',number:2,title:'Two'}],episode:0,title:t(0),sources:['p'],source:'auto',lang:'dub',phase:'playing',position:30,duration:120,changed:Date.now(),note:'',queue:[],...over});
beforeEach(()=>{openTestDatabase();clearSettingsCache();setByPath('guild','modules.streaming',true)});
function member(id:string,channel='voice'){
 return {id,voice:{channelId:channel,channel:{id:channel,type:ChannelType.GuildVoice,permissionsFor:()=>({has:()=>true})}},guild:{id:'guild',ownerId:'owner',members:{me:{}}},permissions:{has:()=>false},roles:{cache:new Collection()}} as any;
}

test('queue helpers add, dedupe, cap, remove and advance in order',()=>{
 const s=fixture();
 assert.equal(addToQueue(s,t(1)),'added');assert.equal(addToQueue(s,t(1)),'duplicate');assert.equal(addToQueue(s,t(0)),'duplicate'); // already queued / already playing
 for(let n=2;n<=MAX_QUEUE;n++)assert.equal(addToQueue(s,t(n)),'added');
 assert.equal(s.queue!.length,MAX_QUEUE);assert.equal(addToQueue(s,t(99)),'full');
 assert.equal(removeFromQueue(s,0)!.id,'id1');assert.equal(removeFromQueue(s,500),null);
 assert.equal(takeNext(s)!.id,'id2');assert.equal(s.queue!.length,MAX_QUEUE-2);
});
test('panel shows a Queue button with a count and an Up next line; queue manager lists items',()=>{
 const s=fixture({queue:[t(1),t(2),t(3),t(4)]});
 const json=JSON.stringify(panel(s,0).toJSON());
 assert(json.includes('Queue · 4'));assert(json.includes('Up next: 1. Show 1'));assert(json.includes('+1 more'));
 const rows=(panel(s,0).toJSON().components.filter((c:any)=>c.type===1) as any[]);assert(rows.every(r=>r.components.length<=5));
 assert(rows[2].components.some((b:any)=>b.custom_id==='tv:aaaaaaaaaaaa:lineup'));
 assert.equal(upNext(fixture()),'');
 const view=queueView(s);assert(view.content.includes('Queue** · 4'));assert(view.components.length===2); // buttons + remove menu
 assert(queueView(fixture()).components.length===1);
});
test('panel detection recognises Camelot panels only',()=>{
 assert(hasPanelControls([panel(fixture(),0).toJSON()] as any));
 assert(!hasPanelControls([{type:1,components:[{type:2,custom_id:'tvr:queue'}]}] as any));
 assert(!hasPanelControls(undefined));
});

function sweepChannel(extra:any[],events:string[]){
 const oldMsg={id:'old',delete:async()=>{events.push('delete:old')}};
 const stale=(id:string,botId='bot',json:any=panel(fixture(),0).toJSON())=>({id,author:{id:botId},components:[json],delete:async()=>{events.push('delete:'+id)}});
 const list=[stale('stalePanel'),stale('otherBot','someoneElse'),{id:'chat',author:{id:'bob'},components:[],delete:async()=>{events.push('delete:chat')}},stale('new'),...extra];
 return {messages:{fetch:async(arg:any)=>typeof arg==='string'?oldMsg:new Collection(list.map(m=>[m.id,m]))},send:async()=>{events.push('send');return {id:'new'}}};
}
test('/stream always posts a fresh panel at the bottom and deletes every older panel',async()=>{
 const tv:any=new Streaming();tv.client={user:{id:'bot'}};tv.session=fixture({message:'old'});
 tv.lastBump=Date.now(); // a recent repost must not block an explicit /stream
 const events:string[]=[];tv.channel=async()=>sweepChannel([],events);
 tv.forceRepost=true;await tv.paint();
 assert.equal(events[0],'send');
 assert(events.includes('delete:old'));assert(events.includes('delete:stalePanel'));
 assert(!events.includes('delete:chat'));assert(!events.includes('delete:otherBot'));assert(!events.includes('delete:new'));
 assert.equal(tv.session.message,'new');assert.equal(tv.forceRepost,false);
});
test('a plain repaint edits the existing panel and does not repost',async()=>{
 const tv:any=new Streaming();tv.client={user:{id:'bot'}};tv.session=fixture({message:'old'});
 const events:string[]=[];
 tv.channel=async()=>({messages:{fetch:async()=>({attachments:new Collection(),edit:async()=>{events.push('edit')},delete:async()=>events.push('delete')})},send:async()=>{events.push('send');return {id:'x'}}});
 await tv.paint();assert.deepEqual(events,['edit']);
});
test('moving to another voice channel removes the old panel',async()=>{
 const tv:any=new Streaming();const deleted:string[]=[];
 tv.client={channels:{fetch:async(id:string)=>({messages:{delete:async(m:string)=>{deleted.push(id+':'+m)}}})}};
 const s=fixture({message:'m1',owner:null});await tv.retire(s);assert.deepEqual(deleted,['voice:m1']);assert.equal(s.message,undefined);
});

function click(customId:string,messageId:string,user=member('alice')){
 const replies:string[]=[];let deletedMsg=false;
 const i:any={customId,message:{id:messageId,delete:async()=>{deletedMsg=true}},isChatInputCommand:()=>false,isRepliable:()=>true,inCachedGuild:()=>true,member:user,isButton:()=>true,isModalSubmit:()=>false,isStringSelectMenu:()=>false,deferred:false,replied:false,
  deferReply:async function(){this.deferred=true},deferUpdate:async function(){this.deferred=true},editReply:async(p:any)=>{replies.push(p.content)},reply:async(p:any)=>{replies.push(p.content)},showModal:async()=>{replies.push('modal')}};
 return {i,replies,deleted:()=>deletedMsg};
}
test('buttons on an older panel are rejected and the old panel is removed',async()=>{
 const tv:any=new Streaming();tv.session=fixture({message:'new'});tv.paint=async()=>{};
 let called=false;tv.bridge={call:async()=>{called=true;return {}},cancelRequests(){}};
 const c=click('tv:aaaaaaaaaaaa:play','stale');
 assert(await tv.handle(c.i));
 assert(/out of date/.test(c.replies[0]!));assert(c.deleted());assert(!called);
});
test('only the controller or an admin can use queue removal; anyone in the VC can open the queue',async()=>{
 const tv:any=new Streaming();tv.session=fixture({queue:[t(1)]});tv.paint=async()=>{};tv.persist=()=>{};
 const bob=click('tv:aaaaaaaaaaaa:lineup','new',member('bob'));await tv.handle(bob.i);assert(/Queue/.test(bob.replies[0]!));
 const clear=click('tv:aaaaaaaaaaaa:qclear','whatever',member('bob'));await tv.handle(clear.i);
 assert(/Only the controller/.test(clear.replies[0]!));assert.equal(tv.session.queue.length,1);
 const outsider=click('tv:aaaaaaaaaaaa:lineup','new',member('carol','elsewhere'));await tv.handle(outsider.i);assert(/Join the active voice/.test(outsider.replies[0]!));
 const owner=click('tv:aaaaaaaaaaaa:qclear','whatever');await tv.handle(owner.i);assert.equal(tv.session.queue.length,0);
});

test('countdown shows 5-4-3-2-1 in chat, removes itself, then starts episode 1',async()=>{
 const tv:any=new Streaming();tv.countdownMs=0;const s=fixture({phase:'idle'});tv.session=s;
 const log:string[]=[];let plays:any[]=[];
 const msg={edit:async(p:any)=>{log.push(p.content)},delete:async()=>{log.push('deleted')}};
 tv.channel=async()=>({send:async(p:any)=>{log.push(p.content);return msg}});
 tv.play=async(pos:number)=>{plays.push(pos);log.push('play')};
 const token=++tv.autoToken;await tv.countdown(s,token);
 assert.deepEqual(log.map(x=>(/\*\*(\d)\*\*/.exec(x)||[])[1]||x),['5','4','3','2','1','deleted','play']);
 assert(log[0]!.startsWith('**Camelot**'));assert.deepEqual(plays,[0]);
});
test('countdown is cancelled by Stop, a new pick or any other control and never plays',async()=>{
 const tv:any=new Streaming();tv.countdownMs=0;const s=fixture({phase:'idle'});tv.session=s;
 let plays=0;const log:string[]=[];tv.play=async()=>{plays++};
 const msg={edit:async()=>{},delete:async()=>{log.push('deleted')}};
 tv.channel=async()=>({send:async()=>{tv.autoToken++;return msg}}); // someone presses Stop right after the first number
 await tv.countdown(s,tv.autoToken);assert.equal(plays,0);assert(log.includes('deleted'));
 s.phase='playing';const t2=tv.autoToken;tv.channel=async()=>({send:async()=>msg});await tv.countdown(s,t2);assert.equal(plays,0); // already playing: nothing to do
});

function tickRig(session:Session,state:any){
 const tv:any=new Streaming();tv.session=session;tv.paint=async()=>{};tv.persist=()=>{};
 setByPath('guild','modules.streaming',true);
 tv.channel=async()=>({members:new Collection([['alice',{id:'alice',user:{bot:false}}]])});
 tv.bridge={call:async(p:string)=>{if(p==='/api/state')return typeof state==='function'?state():state;return {}},get running(){return true},disconnect:async()=>{},cancelRequests(){}};
 return tv;
}
test('when an anime ends the next queued anime loads and auto-starts; the queue shrinks',async()=>{
 const s=fixture({episode:1,queue:[t(1),t(2)]});
 const tv=tickRig(s,{status:'ended',position:0,duration:null,connected:true});
 const loaded:string[]=[];let scheduled=0;tv.loadTitle=async(x:Title)=>{loaded.push(x.id)};tv.scheduleAutoStart=()=>{scheduled++};
 let released=false;tv.release=async()=>{released=true};
 await tv.tick();assert.deepEqual(loaded,['id1']);assert.equal(scheduled,1);assert.equal(s.queue!.length,1);assert(!released);
});
test('a queued anime that no longer loads is skipped and the next one is tried',async()=>{
 const s=fixture({episode:1,queue:[t(1),t(2)]});
 const tv=tickRig(s,{status:'ended',position:0,duration:null,connected:true});
 const loaded:string[]=[];tv.scheduleAutoStart=()=>{};
 tv.loadTitle=async(x:Title)=>{if(x.id==='id1')throw new Error('gone');loaded.push(x.id)};
 await tv.tick();assert.deepEqual(loaded,['id2']);assert.equal(s.queue!.length,0);
});
test('with an empty queue the session is released as before',async()=>{
 const s=fixture({episode:1});const tv=tickRig(s,{status:'ended',position:0,duration:null,connected:true});
 let note='';tv.release=async(n:string)=>{note=n};await tv.tick();assert(/Finished/.test(note));
});
test('the queue waits while earlier episodes of the same anime remain',async()=>{
 const s=fixture({episode:0,queue:[t(1)]});const tv=tickRig(s,{status:'ended',position:0,duration:null,connected:true});
 let started=0;tv.play=async()=>{started++};tv.loadTitle=async()=>{assert.fail('must not skip episodes')};
 await tv.tick();assert.equal(started,1);assert.equal(s.episode,1);assert.equal(s.queue!.length,1);
});
test('release clears the anime queue and cancels pending auto-starts',async()=>{
 const tv:any=new Streaming();const s=fixture({queue:[t(1)]});tv.session=s;tv.paint=async()=>{};tv.bridge={disconnect:async()=>{}};
 const before=tv.autoToken;await tv.release();assert.deepEqual(s.queue,[]);assert(tv.autoToken>before);
});

test('kicked while playing: the bot comes back at the same time and keeps retrying until it works',async()=>{
 const s=fixture({position:30});
 const tv=tickRig(s,{status:'failed',failReason:'kicked',position:42,duration:120,connected:true});
 const attempts:number[]=[];let fail=true;
 tv.startEpisode=async(at:number)=>{attempts.push(at);if(fail)throw new Error('voice busy')};
 await tv.tick();assert.deepEqual(attempts,[42]);assert.equal(tv.rejoinWanted,true);assert.equal(s.phase,'loading');assert(/Trying again/.test(s.note));
 await tv.tick();assert.equal(attempts.length,1); // not hammering: waits 10 s between tries
 tv.lastRejoin=Date.now()-11000;fail=false;
 await tv.tick();assert.deepEqual(attempts,[42,42]);assert.equal(tv.rejoinWanted,false);
});
test('kicked while on the standby screen: rejoins standby without starting a video',async()=>{
 const s=fixture({phase:'idle',title:undefined,episodes:[]});
 const tv=tickRig(s,{status:'failed',failReason:'kicked',position:0,duration:null,connected:true});
 const calls:string[]=[];tv.prepare=async()=>{calls.push('prepare')};
 tv.bridge.call=async(p:string)=>{calls.push(p);return p==='/api/state'?{status:'failed',failReason:'kicked'}:{}};
 let started=0;tv.startEpisode=async()=>{started++};
 await tv.tick();assert(calls.includes('/api/standby'));assert.equal(started,0);assert.equal(tv.rejoinWanted,false);
});
test('Stop ends the rejoin loop',async()=>{
 const tv:any=new Streaming();const s=fixture();tv.session=s;tv.paint=async()=>{};tv.bridge={disconnect:async()=>{}};
 tv.rejoinWanted=true;await tv.release();assert.equal(tv.rejoinWanted,false);
 await tv.tick(); // owner is gone, so nothing happens and nothing throws
});

test('Debug info report shows the stream settings, fixed settings and recent log without links or tokens',async()=>{
 const tv:any=new Streaming();tv.session=fixture({note:'Could not play. Reason: see https://secret.example/x.m3u8'});
 tv.bridge={get running(){return true},call:async()=>({version:'0.12',status:'failed',connected:true,safeMode:false,failReason:'',lastError:'Playback interrupted. https://cdn.example/seg.ts',
  config:{resolution:'1280:720',fps:'30',bitrate:'6000k',preset:'superfast',threads:'4',safeMode:false},envFixes:['STREAM_VIDEO_BITRATE="6000k\'" had stray quotes or spaces; using 6000k'],
  logs:[{time:'10:00:00',kind:'error',msg:'Unknown encoder at https://cdn.example/a.m3u8'}]})};
 const text=await tv.debugReport();
 assert(text.includes('1280:720 at 30 fps · 6000k'));assert(text.includes('Setting fixed'));assert(text.includes('Unknown encoder'));
 assert(!/https?:\/\//.test(text));assert(text.length<2000);
 tv.bridge={get running(){return false}};assert(/not running/.test(await tv.debugReport()));
});
