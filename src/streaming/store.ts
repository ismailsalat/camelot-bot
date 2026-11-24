import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {getDb} from '../db/index.js';
import type {Session} from './model.js';
function table(){getDb().exec('CREATE TABLE IF NOT EXISTS streaming_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')}
function put(key:string,value:string){table();getDb().prepare('INSERT INTO streaming_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
function read(key:string):string|null{table();return (getDb().prepare('SELECT value FROM streaming_state WHERE key=?').get(key) as {value:string}|undefined)?.value??null}
function key(create=false):Buffer{
  const env=process.env.STREAMING_SECRET_KEY;
  if(env){if(!/^[a-f0-9]{64}$/i.test(env))throw new Error('STREAMING_SECRET_KEY must be 64 hexadecimal characters.');return Buffer.from(env,'hex')}
  const path=join(dirname(resolve(process.env.DATABASE_PATH||'data/camelot.sqlite')),'streaming.key');
  mkdirSync(dirname(path),{recursive:true});
  if(!existsSync(path)){if(!create)throw new Error('Streaming encryption key is missing.');writeFileSync(path,randomBytes(32),{mode:0o600,flag:'wx'});}
  const value=readFileSync(path);if(value.length!==32)throw new Error('Streaming encryption key is invalid.');return value;
}
export function saveToken(guild:string,token:string){
  // Forgive common paste artefacts: surrounding quotes, a "Bot "/"Bearer " prefix, stray line breaks.
  token=token.trim().replace(/^["'`]+|["'`]+$/g,'').replace(/^(bot|bearer)\s+/i,'').trim();
  if(token===process.env.DISCORD_TOKEN)throw new Error('Use the separate streaming account, not Camelot’s bot token.');if(token.length<30||token.length>250||/\s/.test(token))throw new Error('That token does not look valid.');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(true),iv);cipher.setAAD(Buffer.from(guild));
  const encrypted=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  put('token:'+guild,Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64'));
}
export function tokenSource(guild:string):string {return read('token:'+guild)?'Saved in Settings':process.env.CAMELOT_STREAMER_TOKEN&&process.env.CAMELOT_GUILD_ID===guild?'Railway variable':'Not set'}
export function hasToken(guild:string){return !!read('token:'+guild)||!!(process.env.CAMELOT_STREAMER_TOKEN&&process.env.CAMELOT_GUILD_ID===guild)}
export function getToken(guild:string):string{
  const stored=read('token:'+guild);
  if(!stored){if(process.env.CAMELOT_GUILD_ID===guild&&process.env.CAMELOT_STREAMER_TOKEN)return process.env.CAMELOT_STREAMER_TOKEN;throw new Error('Ask an admin to save the streaming account in Settings → Streaming.')}
  try{
    const b=Buffer.from(stored,'base64'),dec=createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));
    dec.setAAD(Buffer.from(guild));dec.setAuthTag(b.subarray(12,28));
    return Buffer.concat([dec.update(b.subarray(28)),dec.final()]).toString('utf8');
  }catch{throw new Error('The saved token cannot be opened. Restore streaming.key or save the token again.')}
}
export function clearToken(guild:string){table();getDb().prepare('DELETE FROM streaming_state WHERE key=?').run('token:'+guild)}
export function saveSession(s:Session){put('session',JSON.stringify(s))}
export function restoreSession():Session|null{
  try {
    const s=JSON.parse(read('session')||'null');
    if(!s||typeof s.id!=='string'||typeof s.guild!=='string'||typeof s.channel!=='string'||!Array.isArray(s.episodes)||!Array.isArray(s.sources)||!Number.isInteger(s.episode)||s.episode<0||!Number.isFinite(s.position)||s.position<0||!['sub','dub'].includes(s.lang))return null;
    if(!s.episodes.every((e:any)=>e&&typeof e.id==='string'&&Number.isFinite(e.number))||!s.sources.every((x:any)=>typeof x==='string'))return null;
    if(s.title&&(typeof s.title.id!=='string'||typeof s.title.provider!=='string'||typeof s.title.title!=='string'))return null;
    if(s.title&&typeof s.title.poster!=='string')delete s.title.poster;
    s.duration=Number.isFinite(s.duration)&&s.duration>0?s.duration:null;
    if(typeof s.source!=='string')s.source='auto';
    return s;
  }catch{return null}
}
