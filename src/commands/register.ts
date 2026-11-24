import {REST,Routes} from 'discord.js';
import {loadEnv} from '../env.js';
import {openDatabase} from '../db/index.js';
import {publishCommands} from '../core/publish.js';
import {log,setLogLevel} from '../logger.js';
async function main(){
  const env=loadEnv();setLogLevel(env.logLevel);openDatabase(env.databasePath);
  const rest=new REST({version:'10'}).setToken(env.token);
  const app=await rest.get(Routes.oauth2CurrentApplication()) as {id:string};
  const guilds=await rest.get(Routes.userGuilds(),{query:new URLSearchParams({limit:'200'})}) as Array<{id:string}>;
  const result=await publishCommands({clientId:app.id,token:env.token,devGuildId:env.devGuildId,guildIds:guilds.map(g=>g.id)});
  if(result.reason==='failed')process.exitCode=1;
  else log.info(`Verified ${result.count} slash commands. /stream and !stream are ready in the updated code.`);
}
main().catch(error=>{log.error('Command registration failed',error);process.exitCode=1});
