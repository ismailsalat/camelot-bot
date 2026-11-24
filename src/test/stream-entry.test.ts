import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Collection,ChannelType} from 'discord.js';
import {openTestDatabase,meta} from '../db/index.js';
import {clearSettingsCache,setByPath} from '../db/settings.js';
import {parseTextCommand,handleTextCommand,looksLikeTextCommand} from '../core/textCommands.js';
import {publishCommands,commandFingerprint,commandsMatch} from '../core/publish.js';
import {buildCommands} from '../core/commands.js';
import {streaming,Streaming} from '../streaming/service.js';
import {setLogLevel} from '../logger.js';
beforeEach(()=>{openTestDatabase();clearSettingsCache();setLogLevel('error')});
const body=()=>buildCommands().map(c=>c.toJSON());
const member=()=>({id:'alice',guild:{id:'guild',ownerId:'owner',members:{me:{}}},voice:{channelId:'voice',channel:{id:'voice',type:ChannelType.GuildVoice,permissionsFor:()=>({has:()=>true})}},roles:{cache:new Collection()},permissions:{has:()=>false}} as any);
test('literal !stream works with custom prefixes and disabled general text commands',()=>{
 setByPath('guild','core.prefix','?');setByPath('guild','core.textCommands',false);
 assert.equal(parseTextCommand('!stream','guild')?.name,'stream');assert.equal(parseTextCommand('!STREAM','guild')?.name,'stream');
 assert.equal(parseTextCommand('!streaming','guild'),null);assert.equal(parseTextCommand('?activity','guild'),null);
 setByPath('guild','core.textCommands',true);assert.equal(parseTextCommand('?stream','guild')?.name,'stream');
});
test('text entry opens Streaming instead of redirecting to the missing slash command',async()=>{
 const m=member();const edits:any[]=[];let opened=false;
 const original=streaming.open;
 streaming.open=async(requester)=>{assert.equal(requester,m);opened=true;return{content:'Streaming controls are in <#voice>.',components:[]}};
 const msg={author:{bot:false},system:false,member:m,guildId:'guild',guild:m.guild,content:'!stream',channel:{isTextBased:()=>true,isDMBased:()=>false,permissionsFor:()=>({has:()=>true})},reply:async()=>({edit:async(p:any)=>edits.push(p)})} as any;
 try{assert(looksLikeTextCommand(msg));await handleTextCommand(msg);assert(opened);assert(edits[0].content.includes('<#voice>'))}finally{streaming.open=original}
});
test('bot messages cannot trigger fallback streaming',async()=>{
 const msg={author:{bot:true},system:false} as any;assert(!looksLikeTextCommand(msg));await handleTextCommand(msg);
});
test('shared opener enforces module and voice requirements',async()=>{
 const tv=new Streaming(),m=member();await assert.rejects(tv.open(m),/Streaming is off/);
 setByPath('guild','modules.streaming',true);m.voice.channel=null;await assert.rejects(tv.open(m),/Join a voice channel/);
});
test('shared opener sends busy users to the queue without taking over',async()=>{
 const tv:any=new Streaming();tv.session={owner:'bob',guild:'guild',channel:'voice'};setByPath('guild','modules.streaming',true);
 const result=await tv.open(member());assert(result.content.includes('queue'));assert.equal(tv.session.owner,'bob');assert.equal(result.components[0].toJSON().components[0].custom_id,'tvr:queue');
});
test('shared opener opens actual VC panel and starts standby in order',async()=>{
 const tv:any=new Streaming();const calls:string[]=[];setByPath('guild','modules.streaming',true);
 tv.claim=async()=>{calls.push('claim');tv.session={channel:'voice'}};tv.paint=async(strict:boolean)=>{assert(strict);calls.push('panel')};tv.prepare=async()=>{calls.push('connect')};tv.bridge={call:async(path:string)=>{calls.push(path)}};
 const result=await tv.open(member());await tv.warming;assert.deepEqual(calls,['claim','panel','connect','/api/standby']);assert(result.content.includes('<#voice>'));
});
test('remote missing /stream is repaired in the global set even when the saved fingerprint matches',async()=>{
 meta.set('commands.fingerprint',commandFingerprint());const writes:any[]=[];
 const rest={get:async(route:string)=>route.includes('/guilds/')?[]:body().filter(c=>c.name!=='stream'),put:async(route:string,payload:any)=>writes.push(['put',route,payload]),delete:async()=>assert.fail('nothing to delete')} as any;
 const result=await publishCommands({clientId:'app',token:'unused',guildIds:['guild'],rest});
 assert(result.published);assert.equal(writes.length,1);assert(writes[0][2].body.some((c:any)=>c.name==='stream'));
});
test('duplicate server-scoped /stream is deleted and unrelated server commands are kept',async()=>{
 const deleted:string[]=[];
 const rest={get:async(route:string)=>route.includes('/guilds/')?[{id:'dupe',name:'stream',type:1,description:'old'},{id:'keep',name:'other',type:1,description:'Keep me'}]:body(),put:async()=>assert.fail('global set is current'),delete:async(route:string)=>{deleted.push(route)}} as any;
 const result=await publishCommands({clientId:'app',token:'unused',guildIds:['guild'],rest});
 assert.equal(deleted.length,1);assert(deleted[0]!.endsWith('/guilds/guild/commands/dupe'));assert(result.published);
});
test('registering never creates a server-scoped /stream',async()=>{
 const rest={get:async(route:string)=>route.includes('/guilds/')?[]:body().filter(c=>c.name!=='stream'),put:async(route:string)=>assert(!route.includes('/guilds/')),post:async()=>assert.fail('no per-server posts'),delete:async()=>assert.fail('nothing to delete')} as any;
 await publishCommands({clientId:'app',token:'unused',guildIds:['a','b'],rest});
});
test('remote metadata and default values do not cause needless registration writes',async()=>{
 const rows=body().map(c=>({...c,id:'id',application_id:'app',version:'version',options:c.options??[],default_member_permissions:c.default_member_permissions??null}));
 assert(commandsMatch(rows,body()));
 const rest={get:async(route:string)=>route.includes('/guilds/')?[]:rows,put:async()=>assert.fail('unnecessary put'),delete:async()=>assert.fail('unnecessary delete')} as any;
 const result=await publishCommands({clientId:'app',token:'unused',guildIds:['guild'],rest});assert.equal(result.reason,'unchanged');
});
test('failed global sync is reported and still cleans duplicates',async()=>{
 let cleaned=false;const rest={get:async(route:string)=>{if(!route.includes('/guilds/'))throw Error('temporary');return[{id:'d',name:'stream',type:1,description:'x'}]},put:async()=>{},delete:async()=>{cleaned=true}} as any;
 const result=await publishCommands({clientId:'app',token:'unused',guildIds:['guild'],rest});assert(cleaned);assert.equal(result.reason,'failed');
});
test('development registration never clears global commands in other servers',async()=>{
 const rest={get:async(route:string)=>{assert(route.includes('/guilds/dev/'));return[]},put:async(route:string,payload:any)=>{assert(route.includes('/guilds/dev/'));assert(payload.body.length>0)},delete:async()=>assert.fail('dev mode deletes nothing')} as any;
 const result=await publishCommands({clientId:'app',token:'unused',devGuildId:'dev',rest});assert(result.published);
});
