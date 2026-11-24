// More tolerant 2026 MegaPlay source discovery, without bypassing host access controls.
// Actual playback is not assumed: the caller must decode a frame with FFmpeg.
import {createDecipheriv} from 'node:crypto';

const MP_HOST='https://megaplay.buzz';
const PLAYER_KEY=Buffer.alloc(32);
Buffer.from('i?LMTAx0Q6,:}50U','utf8').copy(PLAYER_KEY);
const PLAYER_IV=Buffer.from("W0;27ToaUpl_P%'c",'utf8');

function asSources(v){
  if(typeof v==='string' && /^https:\/\//.test(v))return v;
  if(v&&typeof v==='object'){
    if(typeof v.file==='string')return v.file;
    if(typeof v.url==='string')return v.url;
    if(Array.isArray(v))for(const item of v){const file=asSources(item);if(file)return file;}
  }
  return null;
}
export function unpackMegaPlaySources(data){
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Video host returned no source response');
  const container=data.data&&typeof data.data==='object' ? data.data : data;
  const tracks=Array.isArray(container.tracks)?container.tracks:[];
  let file=asSources(container.sources) || asSources(container.source);
  if(file)return {file,tracks};
  const enc=container.enc;
  if(typeof enc!=='string'||!enc.length)throw new Error('Video host did not provide a playable source');
  if(enc.length>100000)throw new Error('Video host source response too large');
  let decoded;
  try{
    if(!/^[A-Za-z0-9+/_=-]+$/.test(enc))throw new Error('bad encoding');
    const cipher=Buffer.from(enc,'base64url');
    if(!cipher.length||cipher.length%16!==0)throw new Error('invalid ciphertext');
    const dec=createDecipheriv('aes-256-cbc',PLAYER_KEY,PLAYER_IV);
    decoded=JSON.parse(Buffer.concat([dec.update(cipher),dec.final()]).toString('utf8'));
  }catch{throw new Error('Video host changed its source response format (encrypted payload)')}
  file=asSources(decoded)||asSources(decoded?.sources)||asSources(decoded?.source);
  if(!file)throw new Error('Video host supplied an empty playback URL');
  return {file,tracks:Array.isArray(decoded?.tracks)?decoded.tracks:tracks};
}
export function megaPlayEmbedFor(provider,unitId,language='sub'){
  if(!['sub','dub','raw'].includes(language))throw new Error('Unsupported episode language');
  if(provider==='megaplay'){
    const match=unitId.replace(/^megaplay:/,'').match(/^(\d+):(\d+(?:\.\d+)?)$/);
    if(!match)throw new Error('Invalid MegaPlay episode identifier');
    return `${MP_HOST}/stream/ani/${match[1]}/${match[2]}/${language}`;
  }
  if(provider==='anikoto'){
    const id=unitId.replace(/^anikoto:/,'');
    if(!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw new Error('Invalid Anikoto episode identifier');
    return `${MP_HOST}/stream/s-2/${id}/${language}`;
  }
  throw new Error('Unsupported MegaPlay family provider');
}
export function extractMegaPlayFileId(html){
  if(typeof html!=='string'||html.length>1_000_000)throw new Error('Video host player markup invalid');
  // The title and player tag may differ from one another; prefer the player-tag ID.
  const players=[...html.matchAll(/<[^>]+\bid\s*=\s*["'](?:megaplay-player|megacloud-player|rabbitstream-player|vidcloud-player|vidstream-player)["'][^>]*>/gi)];
  for(const x of players){
    const v=x[0].match(/\bdata-(?:realid|id)\s*=\s*["']([A-Za-z0-9_-]{1,100})["']/i);
    if(v)return v[1];
  }
  const title=html.match(/<title>\s*File\s+([A-Za-z0-9_-]{1,100})\s*-/i);
  if(title)return title[1];
  const data=html.match(/\bdata-(?:realid|id)\s*=\s*["']([A-Za-z0-9_-]{1,100})["']/i);
  return data?.[1]||null;
}
function briefResponseStatus(r){
  return Number.isInteger(r?.status)?`HTTP ${r.status}`:'unavailable';
}
export async function resolveMegaPlayV2(provider,unitId,language,http){
  const embed=megaPlayEmbedFor(provider,unitId,language);
  const opts={headers:{Referer:MP_HOST+'/'},signal:AbortSignal.timeout(16000)};
  const res=await http.get(embed,opts);
  if(!res.ok)throw new Error(`Video host embed ${briefResponseStatus(res)}`);
  const html=await res.text();
  if(html.length>1_000_000)throw new Error('Video host player markup too large');
  if(/<title>\s*(?:Error|403|Access Denied|Just a Moment)/i.test(html))throw new Error('Video host denied the episode embed');
  const id=extractMegaPlayFileId(html);
  if(!id)throw new Error('Video host player changed; no episode file ID');
  const sess=new URL(embed).searchParams.get('s');
  const suffix=sess&&/^[\w-]{1,220}$/.test(sess)?'&s='+encodeURIComponent(sess):'';
  const base=`${MP_HOST}/stream/`;
  const paths=[`getSourcesNew?id=${encodeURIComponent(id)}${suffix}`,`getSources?id=${encodeURIComponent(id)}${suffix}`];
  // Never brute-force endpoints: one newer and one legacy format only.
  let errors=[];
  for(const path of paths){
    const response=await http.get(base+path,{headers:{Referer:embed,'X-Requested-With':'XMLHttpRequest'},signal:AbortSignal.timeout(16000)});
    if(!response.ok){
      const e=`${path.startsWith('getSourcesNew')?'new':'legacy'} player ${briefResponseStatus(response)}`;
      if([401,403,429].includes(response.status))throw new Error(e+'; source host denied access');
      errors.push(e);continue;
    }
    let data;
    try{data=await response.json()}catch{errors.push('Video host returned invalid player JSON');continue}
    try{
      const extracted=unpackMegaPlaySources(data);
      const target=new URL(extracted.file);
      if(target.protocol!=='https:'||target.username||target.password)throw new Error('Unsafe protocol');
      return [{sourceUrl:target.toString(),isHLS:/\.m3u8(?:$|[?#])/i.test(target.toString()) || /\/m3u8(?:$|[?#])/i.test(target.pathname),quality:'auto',language,
        headers:{Referer:MP_HOST+'/'},subtitles:extracted.tracks.filter(t=>t?.kind==='captions'&&typeof t.file==='string'&&/^https:\/\//.test(t.file)).slice(0,15).map(t=>({url:t.file,label:String(t.label||'Subtitles').slice(0,60),language:String(t.label||'unknown').toLowerCase(),format:t.file.includes('.vtt')?'vtt':'srt'}))}];
    }catch(e){errors.push(String(e?.message||'source format unavailable').slice(0,120))}
  }
  throw new Error('Video host source endpoints unavailable: '+errors.slice(0,3).join(' / '));
}
