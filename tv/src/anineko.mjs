// Independent AniNeko source adapter for Camelot TV.
// Parser adapted from the MIT-licensed Kuhi API AniNeko provider:
// https://github.com/aryaniiil/anime-api/blob/main/src/providers/anineko.py
// Copyright belongs to the original contributors; see ATTRIBUTION.md.
// No third-party scripts execute. No browser opens. No downloads are saved.
import {lookup} from 'node:dns/promises';
import {isPublicIP,validateMediaUrl} from './source.mjs';

const BASE='https://anineko.to';
const MAX_HTML=1_200_000;
const SLUG=/^[a-z0-9][a-z0-9-]{0,160}$/;
const entity=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const strip=s=>entity(String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
const attr=(tag,name)=>entity((tag.match(new RegExp('\\b'+name+'\\s*=\\s*["\\\']([^"\\\']*)["\\\']','i'))||[])[1]||'');
export function parseAniNekoSearch(html){
 const hits=[];const seen=new Set();
 for(const m of String(html).matchAll(/<a\b[^>]*class=["'][^"']*nv-anime-thumb[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)){
   const tag=m[0].match(/<a\b[^>]*>/i)?.[0]||'';
   const slug=attr(tag,'href').match(/\/watch\/([a-z0-9-]+)/i)?.[1];
   if(!slug||!SLUG.test(slug)||seen.has(slug))continue;
   const t=m[0].match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]||m[0].match(/class=["'][^"']*nv-anime-title[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1]||'';
   const title=strip(t)||slug.replaceAll('-',' ');
   if(title.length>2){seen.add(slug);hits.push({id:'anineko:'+slug,title,providerId:'anineko',catalogType:'ANIME'})}
 }
 return hits.slice(0,45);
}
export function parseAniNekoEpisodes(html,slug){
 if(!SLUG.test(slug))throw new Error('Invalid anime identifier');
 const episodes=[];const seen=new Set();
 for(const item of String(html).matchAll(/<article\b[^>]*class=["'][^"']*nv-info-episode-item[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)){
   const block=item[1];
   const ep=block.match(/\/ep-(\d+)(?:["'?#/\s]|$)/i)?.[1];
   if(!ep||seen.has(ep))continue;
   const n=Number(ep);if(!Number.isSafeInteger(n)||n<=0||n>10000)continue;
   const title=strip(block.match(/nv-info-episode-main[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1])||`Episode ${n}`;
   const badges=[...block.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(x=>strip(x[1]).toLowerCase());
   const langs=[];if(badges.some(x=>x==='sub'))langs.push('sub');if(badges.some(x=>x==='dub'))langs.push('dub');
   seen.add(ep);episodes.push({id:`anineko:${slug}:${n}`,title,number:n,...(langs.length?{availableLanguages:langs}:{})});
 }
 return episodes.sort((a,b)=>a.number-b.number).slice(0,1000);
}
export function parseAniNekoEmbeds(html,language){
 const embeds=[];const seen=new Set();
 const panels=[...String(html).matchAll(/<div\b[^>]*class=["'][^"']*nv-server-grid[^"']*["'][^>]*data-id=["']([^"']+)["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*nv-server-grid|$)/gi)];
 for(const m of panels){
   const l=m[1].toLowerCase().includes('dub')?'dub':'sub';if(l!==language)continue;
   for(const b of m[2].matchAll(/data-video=["']([^"']+)["']/gi)){
     const url=entity(b[1]); if(validateMediaUrl(url)&&!seen.has(url)){seen.add(url);embeds.push(url)}
   }
 }
 return embeds.slice(0,8);
}
export function parseAniNekoHLS(html){
 // Never use an iframe/embed URL as a direct video source.
 for(const p of [/\bconst\s+src\s*=\s*["'](https:\/\/[^"']+?\.m3u8(?:\?[^"']*)?)["']/i,/\bfile\s*:\s*["'](https:\/\/[^"']+?\.m3u8(?:\?[^"']*)?)["']/i,/["'](https:\/\/[^"']+?\/master\.m3u8(?:\?[^"']*)?)["']/i,/["'](https:\/\/[^"']+?\.m3u8(?:\?[^"']*)?)["']/i]){
   const url=entity(String(html).match(p)?.[1]||'');if(validateMediaUrl(url))return url;
 }
 return null;
}
export async function fetchHtml(url,{referer,fetcher=fetch,timeoutMs=12500}={}){
 let current=validateMediaUrl(url);if(!current)throw new Error('Untrusted provider URL rejected');
 for(let i=0;i<3;i++){
   const u=new URL(current);const addrs=await lookup(u.hostname,{all:true});
   if(!addrs.length||addrs.some(x=>!isPublicIP(x.address)))throw new Error('Non-public provider hostname refused');
   let res;
   try{res=await fetcher(current,{headers:{'User-Agent':'Mozilla/5.0 (compatible; CamelotTV/0.8; episode lookup)','Accept':'text/html,*/*;q=0.8',...(referer?{'Referer':referer}:{})},redirect:'manual',signal:AbortSignal.timeout(timeoutMs)})}
   catch(e){throw new Error(/timeout|abort/i.test(String(e?.message||e))?'Anime source timed out':'Anime source network request failed')}
   if([301,302,303,307,308].includes(res.status)){
     const next=res.headers.get('location');if(!next)throw new Error('Provider redirected without a location');
     current=validateMediaUrl(new URL(next,current).toString());if(!current)throw new Error('Provider redirected to an unsafe URL');
     continue;
   }
   if(res.status===429)throw new Error('AniNeko HTTP 429: rate limited; stop retrying');
   if(!res.ok)throw new Error(`AniNeko HTTP ${res.status}: unavailable`);
   const contentType=res.headers.get('content-type')||'';
   if(!/html|text|json|octet-stream|^$/i.test(contentType))throw new Error('Provider sent non-HTML content');
   const length=Number(res.headers.get('content-length')||0);
   if(length>MAX_HTML)throw new Error('Provider response too large');
   const reader=res.body?.getReader();
   if(!reader){const txt=await res.text();if(txt.length>MAX_HTML)throw new Error('Provider response too large');return txt}
   const parts=[];let n=0;
   for(;;){const {value,done}=await reader.read();if(done)break;n+=value.length;if(n>MAX_HTML){reader.cancel();throw new Error('Provider response too large')}parts.push(value)}
   return new TextDecoder().decode(Buffer.concat(parts.map(x=>Buffer.from(x))));
 }
 throw new Error('Provider redirect loop blocked');
}
export class AniNekoProvider {
 id='anineko';
 async search(query){
   const q=String(query).trim().slice(0,80);if(q.length<2) return [];
   return parseAniNekoSearch(await fetchHtml(`${BASE}/browser?keyword=${encodeURIComponent(q)}`));
 }
 async fetchContentUnits(mediaId){
   const slug=String(mediaId).replace(/^anineko:/,'');
   if(!SLUG.test(slug)||mediaId!==`anineko:${slug}`)throw new Error('Invalid AniNeko series ID');
   return parseAniNekoEpisodes(await fetchHtml(`${BASE}/watch/${slug}`),slug);
 }
 async resolveStream(unitId,language='sub'){
   const m=String(unitId).match(/^anineko:([a-z0-9-]{1,161}):(\d+)$/);
   if(!m||!SLUG.test(m[1])||!['sub','dub'].includes(language))throw new Error('Invalid episode or language');
   const slug=m[1], ep=Number(m[2]);if(ep<1||ep>10000)throw new Error('Episode out of range');
   const watch=`${BASE}/watch/${slug}/ep-${ep}`;
   const embeds=parseAniNekoEmbeds(await fetchHtml(watch,{referer:`${BASE}/watch/${slug}`}),language);
   if(!embeds.length)throw new Error('AniNeko returned no player for this episode/language');
   const streams=[];const failures=[];
   for(const embed of embeds.slice(0,4)){
     try{
       const url=parseAniNekoHLS(await fetchHtml(embed,{referer:BASE+'/'}));
       if(!url){failures.push('embed had no direct HLS');continue}
       streams.push({sourceUrl:url,isHLS:true,quality:'auto',language,headers:{Referer:new URL(embed).origin+'/'}});
     }catch(e){failures.push(String(e?.message||'source error').slice(0,100));if(/429/.test(String(e.message)))break}
   }
   if(!streams.length)throw new Error('AniNeko has no decodable HLS URL: '+[...new Set(failures)].slice(0,2).join('; '));
   return {type:'video',streams};
 }
}
