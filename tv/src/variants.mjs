// Pick a lighter HLS quality. A master playlist lists every quality; left alone, FFmpeg takes the biggest (often 1080p at
// 5-8 Mbit/s) even though we send 720p to Discord. That is more data to download from a CDN that may be slow, and more to
// decode. Choosing the variant that matches the output size needs less bandwidth and CPU for the same picture.
import {validateMediaUrl,assertPublicHost,cleanHeaders} from './source.mjs';

const attrs=line=>{
  const out={};
  for(const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))out[m[1]]=m[2].replace(/^"|"$/g,'');
  return out;
};
/** Parse a master playlist: {variants:[{url,bandwidth,height}], separateAudio}. */
export function parseMaster(text,baseUrl){
  const lines=String(text||'').split(/\r?\n/).map(l=>l.trim());
  const variants=[];let separateAudio=false,pendingAudioGroup=false;
  for(let i=0;i<lines.length;i++){
    const l=lines[i];
    if(l.startsWith('#EXT-X-MEDIA:')){const a=attrs(l.slice(13));if(a.TYPE==='AUDIO'&&a.URI)separateAudio=true}
    else if(l.startsWith('#EXT-X-STREAM-INF:')){
      const a=attrs(l.slice(18));
      let j=i+1;while(j<lines.length&&(!lines[j]||lines[j].startsWith('#')))j++;
      if(!lines[j])continue;
      let url;try{url=new URL(lines[j],baseUrl).href}catch{continue}
      const height=Number(/^\d+x(\d+)$/i.exec(a.RESOLUTION||'')?.[1])||0;
      if(a.AUDIO)pendingAudioGroup=true;
      variants.push({url,bandwidth:Number(a.BANDWIDTH)||0,height,hasAudioGroup:Boolean(a.AUDIO)});
      i=j;
    }
  }
  return {variants,separateAudio:separateAudio&&pendingAudioGroup};
}
/** The variant to use for an output `target` pixels tall, or null to keep the master playlist. */
export function pickVariant(master,target=720){
  const {variants,separateAudio}=master;
  if(separateAudio)return null;                       // the audio lives in another playlist; a lone variant would be silent
  const known=variants.filter(v=>v.height>0);
  if(variants.length<2||known.length<variants.length)return null;
  const fits=known.filter(v=>v.height<=target+8);
  if(!fits.length)return null;                        // only bigger qualities exist: leave it to FFmpeg
  const best=fits.sort((a,b)=>b.height-a.height||b.bandwidth-a.bandwidth)[0];
  const biggest=Math.max(...known.map(v=>v.height));
  if(best.height>=biggest)return null;                // already the top quality
  return {url:best.url,height:best.height,bandwidth:best.bandwidth,of:known.map(v=>v.height).sort((a,b)=>b-a)};
}
async function fetchText(url,headers,{fetcher=fetch,checkHost=assertPublicHost,timeoutMs=6000}={}){
  let current=validateMediaUrl(url);
  if(!current)throw new Error('Invalid playlist URL');
  const signal=AbortSignal.timeout(timeoutMs);
  for(let n=0;n<4;n++){
    await checkHost(current);
    const r=await fetcher(current,{headers:cleanHeaders(headers),signal,redirect:'manual'});
    if([301,302,303,307,308].includes(r.status)){
      const loc=r.headers.get('location');await r.body?.cancel();
      current=loc?validateMediaUrl(new URL(loc,current).href):null;
      if(!current)throw new Error('Playlist redirect rejected');
      continue;
    }
    if(!r.ok){await r.body?.cancel();throw new Error(`Playlist HTTP ${r.status}`)}
    const text=await r.text();
    if(text.length>400000)throw new Error('Playlist too large');
    return {text,url:current};
  }
  throw new Error('Too many playlist redirects');
}
/** Never throws: any problem means "keep using the original URL". */
export async function chooseVariantUrl(url,headers,{target=720,...io}={}){
  try{
    const {text,url:final}=await fetchText(url,headers,io);
    if(!/#EXT-X-STREAM-INF/.test(text))return null;
    const pick=pickVariant(parseMaster(text,final),target);
    if(!pick||!validateMediaUrl(pick.url))return null;
    // Only use it if it really is a media playlist with segments.
    const check=await fetchText(pick.url,headers,io);
    return /#EXTINF/.test(check.text)&&!/#EXT-X-STREAM-INF/.test(check.text)?pick:null;
  }catch{return null}
}
