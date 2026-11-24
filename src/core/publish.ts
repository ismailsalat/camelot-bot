import { createHash } from 'node:crypto';
import { REST, Routes } from 'discord.js';
import { buildCommands } from './commands.js';
import { meta } from '../db/index.js';
import { log } from '../logger.js';

const KEY = 'commands.fingerprint';
export interface PublishResult {published:boolean;count:number;reason:'unchanged'|'changed'|'first-run'|'failed'}
type CommandRest=Pick<REST,'get'|'put'|'delete'>;
function fingerprint(payload:unknown,scope:string):string{
  return createHash('sha256').update(`${scope}\n${JSON.stringify(payload)}`).digest('hex').slice(0,32);
}
function option(o:any):unknown{
  return {type:o.type,name:o.name,description:o.description,required:o.required??false,
    options:(o.options??[]).map(option),choices:o.choices??[],autocomplete:o.autocomplete??false,
    channel_types:o.channel_types??[],min_value:o.min_value??null,max_value:o.max_value??null,
    min_length:o.min_length??null,max_length:o.max_length??null};
}
function command(c:any,guild=false){
  return {type:c.type??1,name:c.name,description:c.description,default_member_permissions:c.default_member_permissions??null,
    dm_permission:guild?false:c.dm_permission??true,options:(c.options??[]).map(option)};
}
export function commandsMatch(remote:any[],desired:any[],guild=false):boolean{
  const normalize=(rows:any[])=>rows.map(c=>command(c,guild)).sort((a,b)=>a.name.localeCompare(b.name)||a.type-b.type);
  return JSON.stringify(normalize(remote))===JSON.stringify(normalize(desired));
}

/** Read Discord on boot. A local fingerprint alone cannot prove a command exists.
 *
 * Every command is registered ONCE, globally. An earlier version also pushed a
 * server-scoped copy of /stream, and Discord lists a global and a server command
 * of the same name side by side, which is why /stream showed up twice. Any
 * leftover server-scoped /stream is deleted here; unrelated server commands are
 * never touched. */
export async function publishCommands(options:{clientId:string;token:string;devGuildId?:string;guildIds?:string[];rest?:CommandRest}):Promise<PublishResult>{
  const body=buildCommands().map(c=>c.toJSON());
  const scope=options.devGuildId?`guild:${options.devGuildId}`:'global';
  const next=fingerprint(body,scope),previous=meta.get(KEY);
  const rest=options.rest??new REST({version:'10',timeout:15000,retries:1}).setToken(options.token);
  const route=options.devGuildId?Routes.applicationGuildCommands(options.clientId,options.devGuildId):Routes.applicationCommands(options.clientId);
  let published=false,failed=false;
  try{
    const remote=await rest.get(route) as any[];
    if(!commandsMatch(remote,body,!!options.devGuildId)){
      await rest.put(route,{body});published=true;
      log.info(`Published ${body.length} commands to ${scope}: ${body.map(c=>c.name).join(', ')}`);
    }
    meta.set(KEY,next);
  }catch(error){failed=true;log.error('Could not sync slash commands. !stream remains available; retrying at startup.',error)}
  // In development mode the dev server already holds the full set; there is nothing to de-duplicate.
  const guilds=options.devGuildId?[]:[...new Set(options.guildIds??[])];
  for(const guildId of guilds){
    try{
      const guildRoute=Routes.applicationGuildCommands(options.clientId,guildId);
      const remote=await rest.get(guildRoute) as any[];
      const stale=remote.filter(c=>c.name==='stream'&&(c.type??1)===1&&c.id);
      for(const old of stale){
        await rest.delete(Routes.applicationGuildCommand(options.clientId,guildId,old.id));published=true;
        log.info(`Removed duplicate server-scoped /stream from server ${guildId}.`);
      }
    }catch(error){failed=true;log.error(`Could not clean up duplicate /stream in server ${guildId}.`,error)}
  }
  if(!failed)log.info(`Verified ${body.length} slash commands against Discord.`);
  return {published,count:body.length,reason:failed?'failed':published?(previous===null?'first-run':'changed'):'unchanged'};
}
export function commandFingerprint(devGuildId?:string):string{
  return fingerprint(buildCommands().map(c=>c.toJSON()),devGuildId?`guild:${devGuildId}`:'global');
}
