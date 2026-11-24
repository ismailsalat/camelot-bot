// Current HiAnime page format, independently implemented from the ani-cli protocol.
// Reference: https://github.com/pystardust/ani-cli/blob/master/ani-cli (GPL-3.0).
import {fetchHtml} from './anineko.mjs';
import {validateMediaUrl} from './source.mjs';
const BASE='https://hianime.at';
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#0?39;/g,"'");
const attr=(tag,name)=>decode(tag.match(new RegExp('\\b'+name+'=["\']([^"\']*)["\']','i'))?.[1]);
function html(raw){try{const j=JSON.parse(raw);return j.html||j.data?.html||''}catch{return raw}}
export function parseSearch(raw){
 const rows=[],seen=new Set();
 for(const m of raw.split('id="main-sidebar"')[0].matchAll(/<h3\b[^>]*class=["'][^"']*film-name[^"']*["'][^>]*>\s*(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)){
  const slug=attr(m[1],'href').split('/').filter(Boolean).pop();
  if(!slug||!/[\w-]+-\d+$/.test(slug)||seen.has(slug))continue;
  seen.add(slug);rows.push({id:'hianime:'+slug,title:attr(m[1],'title')||decode(m[2].replace(/<[^>]*>/g,'')),availableLanguages:['sub','dub']});
 }
 return rows;
}
export function parseEpisodes(raw,slug){
 const out=[];
 for(const m of html(raw).matchAll(/<a\b[^>]*>/gi)){
  const tag=m[0],n=Number(attr(tag,'data-number')),id=attr(tag,'data-id');
  if(!/^\d+$/.test(id)||!Number.isFinite(n)||n<=0||!attr(tag,'href').includes('/watch/'+slug+'?'))continue;
  out.push({id:`hianime:ep:${id}`,number:n,title:attr(tag,'title')||`Episode ${n}`,availableLanguages:[]});
 }
 return out;
}
export function decodePlayer(blob){
 const bytes=Buffer.from(blob,'base64'),key=Buffer.from('otaku-embed-v1');
 if(bytes.length>500000)throw new Error('Player response too large');
 return JSON.parse(Buffer.from(bytes.map((x,i)=>x^key[i%key.length])).toString('utf8'));
}
export class HiAnimeProvider {
 async search(q){return parseSearch(await fetchHtml(BASE+'/search?keyword='+encodeURIComponent(q)))}
 async fetchContentUnits(id){
  const slug=id.replace(/^hianime:/,'');if(!/^[\w-]+-\d+$/.test(slug))throw new Error('Invalid HiAnime title');
  return parseEpisodes(await fetchHtml(BASE+'/api/theme/episode/list/'+slug.split('-').pop()),slug);
 }
 async resolveStream(unit,language){
  const id=unit.match(/^hianime:ep:(\d+)$/)?.[1];if(!id||!['sub','dub'].includes(language))throw new Error('Unsupported episode or language');
  const raw=html(await fetchHtml(BASE+'/api/theme/episode/servers?episodeId='+id));
  const streams=[];
  for(const m of raw.matchAll(/<[^>]+\bdata-hash=["'][^"']+["'][^>]*>/g)){
   if(attr(m[0],'data-type')!==language||attr(m[0],'data-server-name')!=='ZokoAnime')continue;
   const embed=Buffer.from(attr(m[0],'data-hash'),'base64').toString();if(!validateMediaUrl(embed))continue;
   const page=await fetchHtml(embed,{referer:BASE+'/'});
   const blob=page.match(/window\.__P\s*=\s*["']([^"']+)["']/)?.[1];if(!blob)continue;
   const config=decodePlayer(blob),source=config.src;
   if(!validateMediaUrl(source))continue;
   streams.push({sourceUrl:source,isHLS:true,quality:'auto',language,headers:{Referer:new URL(embed).origin+'/'},subtitles:(config.subtitles||[]).map(t=>({url:t.src,language:t.lang||'en',label:t.label||'English'}))});
  }
  if(!streams.length)throw new Error('HiAnime has no supported stream for this language');
  return {type:'video',streams};
 }
}
