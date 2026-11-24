import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {ChannelType,Collection} from 'discord.js';
import {openTestDatabase} from '../db/index.js';
import {clearSettingsCache,getSettings} from '../db/settings.js';
import {saveToken,getToken} from '../streaming/store.js';
import {settingsCard} from '../streaming/ui.js';
import {Streaming} from '../streaming/service.js';
import {MODULES} from '../core/registry.js';
import {setLogLevel} from '../logger.js';

beforeEach(()=>{openTestDatabase();clearSettingsCache();setLogLevel('error')});

function admin(){
  return {id:'admin',voice:{channelId:'voice',channel:{id:'voice',type:ChannelType.GuildVoice}},guild:{id:'guild',ownerId:'owner',members:{me:{}}},permissions:{has:()=>true},roles:{cache:new Collection()}} as any;
}
const ids=(card:unknown)=>JSON.stringify(card);

test('Streaming settings offer an admin a Turn on button while it is off, and Turn off while on',async()=>{
  const m=admin();
  assert(ids(settingsCard(m).toJSON()).includes('Turn on Streaming'));
  assert(ids(settingsCard(m).toJSON()).includes('tvs:toggle'));
  const tv:any=new Streaming();
  const edits:any[]=[];
  const i:any={isButton:()=>true,isModalSubmit:()=>false,deferReply:async()=>{},editReply:async(p:any)=>edits.push(p)};
  await tv.settings(i,m,'toggle');
  assert.equal(getSettings('guild').modules.streaming,true);
  assert(ids(edits[0].components[0].toJSON()).includes('Turn off Streaming'));
  await tv.settings(i,m,'toggle');
  assert.equal(getSettings('guild').modules.streaming,false);
});

test('a plain member cannot flip Streaming from the settings handler',async()=>{
  const tv:any=new Streaming();
  const member={...admin(),permissions:{has:()=>false}};
  await assert.rejects(tv.settings({isButton:()=>true,deferReply:async()=>{}},member,'toggle'),/Admins only/);
  assert.equal(getSettings('guild').modules.streaming,false);
});

test('Modules lists Core, Clips, Activity, The Purge and then Streaming',()=>{
  assert.deepEqual(MODULES.map(x=>x.key),['core','clips','activity','purge','streaming']);
});

test('pasted tokens are cleaned of quotes and a Bot prefix before saving',()=>{
  const raw='A'.repeat(24)+'.'+'B'.repeat(6)+'.'+'C'.repeat(27);
  saveToken('guild',`  "${raw}"\n`);assert.equal(getToken('guild'),raw);
  saveToken('guild',`Bot ${raw}`);assert.equal(getToken('guild'),raw);
  assert.throws(()=>saveToken('guild','short'),/does not look valid/);
});

test('a worker that dies while starting Play is reconnected once and the episode still plays',async()=>{
  const tv:any=new Streaming();const calls:string[]=[];let plays=0;
  tv.session={id:'s1',guild:'guild',channel:'voice',owner:'admin',episodes:[{id:'e1',number:1}],episode:0,sources:[],source:'auto',lang:'dub',phase:'idle',position:0,duration:null,changed:Date.now(),note:'',title:{id:'hianime:1',provider:'hianime',title:'Dr. Stone'}};
  tv.paint=async()=>{};tv.persist=()=>{};
  tv.prepare=async()=>{calls.push('prepare')};
  tv.bridge={call:async(path:string)=>{
    if(path.startsWith('/api/episodes'))return {sources:[{status:'checked',provider:'hianime'}],episodes:[{id:'e1',number:1}]};
    plays++;calls.push('play');
    if(plays===1)throw new Error('No playable video found from the matching sources. hianime: Streaming account disconnected. | anikoto: Streamer is not connected');
    return {provider:'hianime'};
  }};
  await tv.startEpisode(0);
  assert.deepEqual(calls,['prepare','play','prepare','play']);
  assert.equal(tv.session.actualSource,'hianime');
});

test('an ordinary source failure is not retried as a crash',async()=>{
  const tv:any=new Streaming();let plays=0;
  tv.session={id:'s1',guild:'guild',channel:'voice',owner:'admin',episodes:[{id:'e1',number:1}],episode:0,sources:[],source:'auto',lang:'dub',phase:'idle',position:0,duration:null,changed:Date.now(),note:'',title:{id:'hianime:1',provider:'hianime',title:'Dr. Stone'}};
  tv.paint=async()=>{};tv.persist=()=>{};tv.prepare=async()=>{};
  tv.bridge={call:async(path:string)=>{if(path.startsWith('/api/episodes'))return {sources:[],episodes:[{id:'e1',number:1}]};plays++;throw new Error('allmanga: no source URLs')}};
  await assert.rejects(tv.startEpisode(0),/no source URLs/);
  assert.equal(plays,1);
});

test('a background warm-up and a later connect share one connection attempt',async()=>{
  const {Bridge}=await import('../streaming/bridge.js');
  const b:any=new Bridge();let started=0;
  b.doConnect=async()=>{started++;await new Promise(r=>setTimeout(r,20))};
  await Promise.all([b.connect('g','t'),b.connect('g','t')]);
  assert.equal(started,1);
  await b.connect('g','t');assert.equal(started,2);
});

test('after a crash the TV service restarts empty: the title is searched again before the retry plays',async()=>{
  const tv:any=new Streaming();const calls:string[]=[];let restarted=false,plays=0;
  tv.session={id:'s1',guild:'guild',channel:'voice',owner:'admin',episodes:[{id:'e1',number:1}],episode:0,sources:[],source:'auto',lang:'dub',phase:'idle',position:0,duration:null,changed:Date.now(),note:'',title:{id:'hianime:1',provider:'hianime',title:'Dr. Stone'}};
  tv.paint=async()=>{};tv.persist=()=>{};
  tv.prepare=async()=>{calls.push('prepare');if(plays===1)restarted=true};
  tv.bridge={call:async(path:string)=>{
    if(path.startsWith('/api/episodes')){calls.push('episodes');if(restarted&&!calls.includes('search'))throw new Error('Search for this anime first');return {sources:[{status:'checked',provider:'hianime'}],episodes:[{id:'e1',number:1}]}}
    if(path.startsWith('/api/search')){calls.push('search');return {results:[{id:'hianime:1',provider:'hianime',title:'Dr. Stone'}]}}
    plays++;calls.push('play');
    if(plays===1)throw new Error('No playable video found. hianime: Streaming account disconnected.');
    if(!calls.includes('search'))throw new Error('Choose an anime and episode from search results first');
    return {provider:'hianime'};
  }};
  await tv.startEpisode(0);
  assert.equal(tv.session.actualSource,'hianime');
  assert(calls.indexOf('search')>calls.lastIndexOf('prepare'));assert(calls.indexOf('search')<calls.lastIndexOf('play'));
});
