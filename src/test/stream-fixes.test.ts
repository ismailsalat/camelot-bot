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
