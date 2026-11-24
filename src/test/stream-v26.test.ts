import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {ChannelType,Collection} from 'discord.js';
import {openTestDatabase} from '../db/index.js';
import {setByPath,clearSettingsCache} from '../db/settings.js';
import {saveToken} from '../streaming/store.js';
import {type Session} from '../streaming/model.js';
import {Streaming} from '../streaming/service.js';
import {panel} from '../streaming/ui.js';
process.env.STREAMING_SECRET_KEY='ab'.repeat(32);
const fixture=(over:Partial<Session>={}):Session=>({id:'aaaaaaaaaaaa',guild:'guild',channel:'voice',owner:'alice',message:'new',episodes:[{id:'e1',number:1,title:'One'},{id:'e2',number:2,title:'Two'}],episode:0,title:{id:'x',provider:'p',title:'Dragon Ball Z'},sources:['p'],source:'auto',lang:'dub',phase:'playing',position:30,duration:120,changed:Date.now(),note:'',queue:[],...over});
beforeEach(()=>{openTestDatabase();clearSettingsCache();setByPath('guild','modules.streaming',true);saveToken('guild','a'.repeat(60))});
const member=(id:string)=>({id,voice:{channelId:'voice',channel:{id:'voice',type:ChannelType.GuildVoice,permissionsFor:()=>({has:()=>true})}},guild:{id:'guild',ownerId:'owner',members:{me:{}}},permissions:{has:()=>false},roles:{cache:new Collection()}}) as any;
function button(op:string,message='new'){
  const log:string[]=[];
  const i:any={customId:`tv:aaaaaaaaaaaa:${op}`,message:{id:message,delete:async()=>{}},isChatInputCommand:()=>false,isRepliable:()=>true,inCachedGuild:()=>true,member:member('alice'),isButton:()=>true,isModalSubmit:()=>false,isStringSelectMenu:()=>false,deferred:false,replied:false,createdTimestamp:Date.now(),
    deferUpdate:async function(){this.deferred=true;log.push('update')},deferReply:async function(){this.deferred=true;log.push('defer')},followUp:async(p:any)=>{log.push('followUp:'+p.content)},editReply:async(p:any)=>{log.push('edit:'+p.content)},reply:async(p:any)=>{log.push('reply:'+p.content)},deleteReply:async()=>{log.push('delete')}};
  return {i,log};
}
const rig=(s:Session)=>{const tv:any=new Streaming();tv.session=s;tv.paint=async()=>{};tv.persist=()=>{};tv.bridge={connect:async()=>{},call:async()=>({streamerId:'s'}),cancelRequests(){},async close(){}};return tv};

test('clicking Next while a long change is still running does nothing visible: no busy message, no extra work',async()=>{
  const tv=rig(fixture());let release!:()=>void;let ran=0;
  const holding=tv.gate.run(()=>new Promise<void>(r=>release=r));
  tv.play=async()=>{ran++};
  const clicks=[button('next'),button('next'),button('next')];
  await Promise.all(clicks.map(c=>tv.handle(c.i)));
  for(const c of clicks)assert.deepEqual(c.log,['update'],'only the silent acknowledgement; nothing is posted');
  assert.equal(ran,0);release();await holding;
});

test('a click that arrives just before the current change finishes waits for it and then works',async()=>{
  const tv=rig(fixture());let release!:()=>void;let ran=0;
  const holding=tv.gate.run(()=>new Promise<void>(r=>release=r));
  tv.play=async()=>{ran++};
  setTimeout(()=>release(),40);
  const c=button('next');await tv.handle(c.i);await holding;
  assert.equal(ran,1);assert.equal(tv.session.episode,1);assert.deepEqual(c.log,['update']);
});

test('a real problem on a panel button is still reported, privately, without touching the panel',async()=>{
  const tv=rig(fixture({episode:1}));
  const c=button('next');await tv.handle(c.i);
  assert.equal(c.log[0],'update');assert.match(c.log[1]!,/^followUp:.*last episode/);assert.ok(!c.log.some(x=>x==='delete'||x.startsWith('edit:')));
});

test('Stop still shows its own answer',async()=>{
  const tv=rig(fixture());tv.release=async()=>{};
  const c=button('stop');await tv.handle(c.i);
  assert.equal(c.log[0],'defer');assert.ok(c.log.some(x=>/stopped/i.test(x)));
});

test('the 10 s / 30 s skip buttons are gone, the Skip intro button remains, and old panels with them are rejected quietly',async()=>{
  const tv=rig(fixture());let seeks=0;
  tv.bridge.call=async(path:string)=>{if(path==='/api/seek'){seeks++;return {}}return {status:'streaming',position:30,duration:1400,streamerId:'s'}};
  const old=button('skipf');await tv.handle(old.i);assert.equal(seeks,0);
  const intro=button('skipop');await tv.handle(intro.i);assert.equal(seeks,1);assert.deepEqual(intro.log,['update']);
});

test('the panel shows a live Discord countdown while the stream counts down, and drops it afterwards',()=>{
  const find=(s:Session)=>JSON.stringify(panel(s,0).toJSON());
  const now=Date.now();
  assert.match(find(fixture({phase:'loading',countdownUntil:now+5000})),/Starting <t:\d+:R>/);
  assert.doesNotMatch(find(fixture({phase:'playing',countdownUntil:undefined})),/Starting <t:/);
  assert.doesNotMatch(find(fixture({phase:'loading',countdownUntil:now-1000})),/Starting <t:/);
});

test('Play on a restored session starts the 5-4-3-2-1 on the stream and shows it on the panel',async()=>{
  const tv=rig(fixture({phase:'idle',owner:'alice',episodes:[{id:'e1',number:1}],position:0,duration:null}));
  const calls:any[]=[];tv.prepare=async()=>{};
  tv.bridge.call=async(path:string,body:any)=>{calls.push([path,body]);
    if(path.startsWith('/api/episodes'))return {selection:{provider:'p',id:'x'},sources:[{status:'checked',provider:'p'}],episodes:[{id:'e1',number:1}]};
    if(path==='/api/countdown')return {endsAt:Date.now()+5000};
    if(path==='/api/play'){await new Promise(r=>setTimeout(r,10));assert.ok(body.countdownId,'the play request carries the countdown id');assert.ok(tv.session.countdownUntil>Date.now(),'the panel already has its countdown');return {provider:'p'}}
    return {streamerId:'s',status:'streaming',position:0}};
  await tv.startEpisode(0,true);
  assert.ok(calls.some(c=>c[0]==='/api/countdown'));assert.equal(tv.session.countdownUntil,undefined);
});

test('the private message after picking an anime names the title and the on-stream countdown',()=>{
  const tv:any=new Streaming();
  const m=tv.readyMessage(fixture({title:{id:'x',provider:'p',title:'Dragon Ball Z'},episodes:[{id:'1',number:1,languages:['sub','dub']},{id:'2',number:2,languages:['sub']}] as any}));
  assert.match(m,/Dragon Ball Z/);assert.match(m,/2 episodes/);assert.match(m,/SUB & DUB/);assert.match(m,/5-4-3-2-1/);assert.match(m,/Stop/);assert.doesNotMatch(m,/VC chat/);
});

test('opening /stream with a restored anime warms the account and the standby screen; picking something else meanwhile cancels the standby',async()=>{
  const run=async(change:boolean)=>{
    const tv:any=new Streaming();const calls:string[]=[];const title={id:'x',provider:'p',title:'Dragon Ball Z'};
    tv.session=fixture({phase:'idle',title});tv.claim=async()=>{};tv.paint=async()=>{};
    tv.prepare=async()=>{calls.push('connect');if(change)tv.session.title={id:'y',provider:'p',title:'Other'}};
    tv.bridge={call:async(path:string)=>{calls.push(path)}};
    setByPath('guild','modules.streaming',true);
    await tv.open(member('alice'));await tv.warming;return calls;
  };
  assert.deepEqual(await run(false),['connect','/api/standby']);
  assert.deepEqual(await run(true),['connect']);
});
test('a failed warm-up of a restored session is not shown as an error; Play connects again',async()=>{
  const tv:any=new Streaming();tv.session=fixture({phase:'idle'});tv.claim=async()=>{};tv.paint=async()=>{};tv.persist=()=>{};
  tv.prepare=async()=>{throw new Error('login failed')};tv.bridge={call:async()=>{}};setByPath('guild','modules.streaming',true);
  await tv.open(member('alice'));await tv.warming;assert.equal(tv.session.phase,'idle');
});
