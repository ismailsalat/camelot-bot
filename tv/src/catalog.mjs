// Separate anime metadata from online playback providers. An anime title is NOT a playable stream.
// No DRM circumvention, proxying, or misleading auto-generated episodes.
const QUERY=`query ($search:String!) { Page(page:1,perPage:15) { media(search:$search,type:ANIME,sort:SEARCH_MATCH,isAdult:false) { id title { english romaji native } seasonYear episodes format coverImage { large } } } }`;
export function normTitle(v){return String(v||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ')}
export function sameAnime(catalog,hit){
  // A terminal audio marker is not a new season. Preserve all season/part numbers.
  const normalize=v=>normTitle(String(v||'').replace(/\s*\((?:english\s+)?(?:dub|sub|dubbed)\)\s*$/i,''));
  const names=[catalog?.title,...(catalog?.aliases||[])].map(normalize).filter(Boolean);
  const candidates=[hit?.title,...(hit?.aliases||[])].map(normalize).filter(Boolean);
  if(!candidates.some(name=>names.includes(name)))return false;
  // Reject different-year adaptations/seasons when both releases are known.
  return !(Number(catalog.year)>0 && Number(hit.year)>0 && Math.abs(Number(catalog.year)-Number(hit.year))>1);
}
function safeItems(items){
 const seen=new Set();return items.filter(Boolean).map(x=>({
   id:String(x.id),provider:'catalog',title:String(x.title||'Untitled').slice(0,125),
   aliases:Array.isArray(x.aliases)?x.aliases.filter(Boolean).slice(0,4):[],
   year:Number(x.year)||null,numberOfEpisodes:Number(x.numberOfEpisodes)||null,
   poster:typeof x.poster==='string'?x.poster:'',languages:[],availability:'catalog-only',catalogSource:x.catalogSource
 })).filter(x=>{if(seen.has(normTitle(x.title)))return false;seen.add(normTitle(x.title));return true}).slice(0,15)
}
export async function searchAnimeCatalog(query,{fetcher=fetch,timeoutMs=9000}={}){
 const q=String(query||'').trim().slice(0,80);
 if(q.length<2)throw new Error('Enter at least two letters');
 let errors=[];
 try {
   const res=await fetcher('https://graphql.anilist.co',{method:'POST',
     headers:{'Content-Type':'application/json','Accept':'application/json'},
     body:JSON.stringify({query:QUERY,variables:{search:q}}),signal:AbortSignal.timeout(timeoutMs)});
   if(!res.ok)throw new Error(`HTTP ${res.status}`);
   const data=await res.json();
   if(data.errors?.length)throw new Error('AniList GraphQL rejected request');
   if(!Array.isArray(data.data?.Page?.media))throw new Error('AniList response invalid');
   return {results:safeItems(data.data.Page.media.map(m=>({id:`catalog:anilist:${m.id}`,title:m.title?.english||m.title?.romaji||m.title?.native,
      aliases:[m.title?.english,m.title?.romaji,m.title?.native],poster:m.coverImage?.large,year:m.seasonYear,numberOfEpisodes:m.episodes,catalogSource:'AniList'}))),source:'AniList',errors};
 }catch(e){errors.push(`AniList: ${/HTTP \d+/.test(e.message||'')?e.message:'unavailable or timed out'}`)}
 // Jikan is a second independent catalog; unlike a stream site it only provides metadata.
 try{
   const url='https://api.jikan.moe/v4/anime?q='+encodeURIComponent(q)+'&limit=15&sfw=true';
   const res=await fetcher(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
   if(!res.ok)throw new Error(`HTTP ${res.status}`);
   const data=await res.json();if(!Array.isArray(data.data))throw new Error('Invalid response');
   return {results:safeItems(data.data.map(m=>({id:`catalog:jikan:${m.mal_id}`,title:m.title_english||m.title,
      aliases:[m.title,m.title_english,m.title_japanese],poster:m.images?.jpg?.large_image_url,year:m.year||Number(m.aired?.from?.slice(0,4)),numberOfEpisodes:m.episodes,catalogSource:'Jikan'}))),source:'Jikan',errors};
 }catch(e){errors.push(`Jikan: ${/HTTP \d+/.test(e.message||'')?e.message:'unavailable or timed out'}`)}
 return {results:[],source:null,errors};
}
