import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateMediaUrl,assertPublicHost,cleanHeaders} from './source.mjs';
const run=promisify(execFile);
const LIMIT=2*1024*1024;
const aliases={en:['en','eng','english'],ar:['ar','ara','arabic'],es:['es','spa','spanish'],fr:['fr','fra','french'],it:['it','ita','italian'],de:['de','deu','german'],pt:['pt','por','portuguese'],ru:['ru','rus','russian']};
export const SUBTITLE_CHOICES=['off',...Object.keys(aliases)];
export function pickSubtitle(tracks,language='en') {
  if(language==='off')return null;
  const words=aliases[language];
  if(!words)throw new Error('Unsupported subtitle language');
  const names=t=>[t.language,t.label].map(v=>String(v||'').toLowerCase().trim()).filter(Boolean);
  const exact=t=>names(t).some(v=>words.some(w=>v===w||v.startsWith(w+' ')||v.startsWith(w+'-')||v.startsWith(w+'_')));
  // "English (CC)", "English - Subs", "[English]": the language name as a whole word anywhere in the label also counts.
  const long=words.filter(w=>w.length>=3);
  const named=t=>names(t).some(v=>long.some(w=>new RegExp(`(?:^|[^a-z])${w}(?:[^a-z]|$)`).test(v)));
  const usable=(tracks||[]).filter(t=>t&&(exact(t)||named(t)));
  // Prefer complete dialogue captions over signs/songs-only tracks.
  return usable.sort((a,b)=>Number(/sign|song|forced/i.test(a.label||''))-Number(/sign|song|forced/i.test(b.label||''))||Number(exact(b))-Number(exact(a)))[0]||null;
}
/** Short, safe description of what a source offered: used in logs and diagnostics. */
export function describeTracks(tracks){return (tracks||[]).slice(0,8).map(t=>String(t?.label||t?.language||'').replace(/[^\w .()\-\[\]]/g,'').slice(0,30)||'?')}
export function detectSubtitleFormat(text) {
  const content=String(text).replace(/^\uFEFF/,'').trimStart();
  if(content.length>LIMIT||content.includes('\0'))throw new Error('Invalid subtitle file');
  if(/^WEBVTT(?:\s|$)/.test(content))return 'webvtt';
  if(/^\[Script Info\]/i.test(content)&&/\[Events\]/i.test(content))return 'ass';
  if(/(?:^|\n)\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(content))return 'srt';
  throw new Error('Subtitle host returned no supported caption file');
}
export async function fetchSubtitle(url,headers={}, {fetcher=fetch,checkHost=assertPublicHost}={}) {
  let current=validateMediaUrl(url);
  if(!current)throw new Error('Invalid subtitle URL');
  const signal=AbortSignal.timeout(15000);
  for(let n=0;n<4;n++){
    await checkHost(current);
    const r=await fetcher(current,{headers:cleanHeaders(headers),signal,redirect:'manual'});
    if([301,302,303,307,308].includes(r.status)){
      const location=r.headers.get('location');await r.body?.cancel();
      current=location?validateMediaUrl(new URL(location,current).href):null;
      if(!current)throw new Error('Subtitle redirect rejected');
      continue;
    }
    if(!r.ok){await r.body?.cancel();throw new Error(`Subtitle source HTTP ${r.status}`);}
    if(Number(r.headers.get('content-length'))>LIMIT){await r.body?.cancel();throw new Error('Subtitle file too large');}
    let size=0;const chunks=[];
    for await(const chunk of r.body){size+=chunk.length;if(size>LIMIT)throw new Error('Subtitle file too large');chunks.push(Buffer.from(chunk));}
    const text=Buffer.concat(chunks).toString('utf8');detectSubtitleFormat(text);return text;
  }
  throw new Error('Too many subtitle redirects');
}
// Only server-generated paths are ever inserted into FFmpeg filter expressions.
export function subtitleFilter(path) {
  if(!/^\/[A-Za-z0-9_./-]+\.ass$/.test(path))throw new Error('Unsupported subtitle cache path');
  return `ass=filename=${path}`;
}
export async function prepareSubtitleText(text,{shouldStop=()=>false}={}) {
  if(shouldStop())throw new Error('Video check cancelled');
  const format=detectSubtitleFormat(text);
  const dir=await mkdtemp(join(tmpdir(),'camelot-tv-subs-'));
  const input=join(dir,'source.txt'),output=join(dir,'captions.ass');
  try{
    subtitleFilter(output);
    await writeFile(input,text,{mode:0o600});
    // Force a text demuxer; never probe a remote playlist or HTML as subtitles.
    await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file','-f',format,'-i',input,'-map','0:s:0','-c:s','ass','-y',output],{timeout:15000,maxBuffer:200000});
    const ass=await readFile(output,'utf8');
    if(!/^Dialogue:/m.test(ass))throw new Error('Subtitle file contains no dialogue cues');
    if(shouldStop())throw new Error('Video check cancelled');
    return {subtitlePath:output,subtitleDir:dir};
  }catch(e){await rm(dir,{recursive:true,force:true});if(/cancelled/.test(e.message))throw e;throw new Error('Could not prepare captions. Check FFmpeg subtitle support or choose Subtitles Off.');}
}
export async function prepareCaptions(source,choice='en',{shouldStop=()=>false}={}) {
  if(!SUBTITLE_CHOICES.includes(choice))throw new Error('Unsupported subtitle choice');
  if(choice==='off')return {...source,subtitleStatus:{mode:'off',label:'Off'}};
  const track=pickSubtitle(source.subtitles,choice);
  // Never label untranslated video as subtitled. Try the next source instead.
  if(!track){
    const offered=describeTracks(source.subtitles);
    throw new Error(`No separate ${choice.toUpperCase()} captions from this source (it offered: ${offered.length?offered.join(', '):'no caption tracks'}). Trying another source; choose Subtitles Off to allow video without a separate caption track.`);
  }
  const text=await fetchSubtitle(track.url,source.headers);
  const files=await prepareSubtitleText(text,{shouldStop});
  return {...source,...files,subtitleStatus:{mode:'burned',language:choice,label:String(track.label||choice).slice(0,80)}};
}
export async function discardCaptions(source) {
  if(source?.subtitleDir)await rm(source.subtitleDir,{recursive:true,force:true});
}
