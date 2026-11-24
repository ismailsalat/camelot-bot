// Separate anime metadata from online playback providers. An anime title is NOT a playable stream.
// No DRM circumvention, proxying, or misleading auto-generated episodes.
const QUERY=`query ($search:String!) { Page(page:1,perPage:20) { media(search:$search,type:ANIME,sort:SEARCH_MATCH,isAdult:false) { id idMal title { english romaji native } synonyms seasonYear startDate { year } episodes format status popularity coverImage { large } } } }`;
// Characters that stand for letters or words in anime titles: "Hunter × Hunter", "Fate/Zero", "Tom & Jerry", "Re:Zero".
const CHAR_MAP={'×':' x ','✕':' x ','✖':' x ','&':' and ','＆':' and ','∞':' infinity ','☆':' ','★':' ','♥':' ','♡':' '};
export function normTitle(v){
  return String(v||'').replace(/[×✕✖&＆∞☆★♥♡]/g,c=>CHAR_MAP[c]).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
/** A "(2011)" style release year written in a title, or null. */
export function titleYear(v){const s=String(v||'');const m=s.match(/\((19[5-9]\d|20\d\d)\)/)||s.match(/\s(19[5-9]\d|20\d\d)(?:\s*\((?:dub|sub|dubbed|english dub)\))?$/i);return m?Number(m[1]):null}
// Sources write the year as "(2011)", as a bare "2011" at the end, or add a "(TV)" label; none of these is part of the name.
export const stripYear=v=>String(v||'').replace(/\s*\((?:19[5-9]\d|20\d\d)\)/g,' ').replace(/\s*\((?:tv|tv series|tv anime)\)/gi,' ').replace(/(\S)\s+(?:19[5-9]\d|20\d\d)\s*$/,'$1');
/** Well-known short names people type. Expanding them lets the sources find the real title. */
export const QUERY_ALIASES={hxh:'hunter x hunter',jjk:'jujutsu kaisen',aot:'attack on titan',snk:'shingeki no kyojin',mha:'my hero academia',bnha:'boku no hero academia',
  fmab:'fullmetal alchemist brotherhood',fma:'fullmetal alchemist',opm:'one punch man',dbz:'dragon ball z',dbs:'dragon ball super',dbgt:'dragon ball gt',kny:'kimetsu no yaiba',
  csm:'chainsaw man',sao:'sword art online',tpn:'the promised neverland',hsdxd:'highschool dxd',nge:'neon genesis evangelion',jojo:'jojo bizarre adventure',
  tensura:'that time i got reincarnated as a slime',rezero:'re zero',
  spyxfamily:'spy x family'};
export function expandQuery(q){
  const key=normTitle(q).replace(/ /g,'');
  const direct=QUERY_ALIASES[normTitle(q)]||QUERY_ALIASES[key];
  return direct&&normTitle(direct)!==normTitle(q)?direct:String(q||'').trim();
}
/** A title reduced to what identifies the show: no year, "(TV)", "Dub/Sub" label, punctuation or case. */
export function baseName(v){
  return normTitle(stripYear(String(v||'').replace(/\s*\((?:english\s+)?(?:dub|sub|dubbed)\)\s*$/i,'').replace(/(\S)\s+(?:dub|dubbed|sub)\s*$/i,'$1')));
}
export function sameAnime(catalog,hit){
  // A terminal audio marker is not a new season. Preserve all season/part numbers.
  // A "(2011)" release year is metadata, not part of the name: it is compared as a year below, so that
  // "Hunter x Hunter (2011)" finds "Hunter × Hunter" but never the 1999 series.
  const dubTag=/\s*\((?:english\s+)?(?:dub|sub|dubbed)\)\s*$/i;
  const normalize=v=>normTitle(stripYear(String(v||'').replace(dubTag,'').replace(/(\S)\s+(?:dub|dubbed|sub)\s*$/i,'$1')));
  const names=[catalog?.title,...(catalog?.aliases||[])].map(normalize).filter(Boolean);
  const candidates=[hit?.title,...(hit?.aliases||[])].map(normalize).filter(Boolean);
  if(!candidates.some(name=>names.includes(name)))return false;
  const years=x=>[Number(x?.year),titleYear(x?.title),...(x?.aliases||[]).map(titleYear)].filter(y=>y>0);
  const a=years(catalog),b=years(hit);
  // Reject different-year adaptations/seasons when both releases are known.
  return !(a.length&&b.length&&!a.some(x=>b.some(y=>Math.abs(x-y)<=1)));
}
const FORMATS=new Set(['TV','TV_SHORT','MOVIE','SPECIAL','OVA','ONA','MUSIC']);
const JIKAN_FORMAT={tv:'TV',movie:'MOVIE',ova:'OVA',special:'SPECIAL',ona:'ONA',music:'MUSIC','tv special':'SPECIAL',cm:'SPECIAL',pv:'SPECIAL'};
const STATUSES=new Set(['FINISHED','RELEASING','NOT_YET_RELEASED','CANCELLED','HIATUS']);
function safeItems(items){
 const seen=new Set();return items.filter(Boolean).map(x=>({
   id:String(x.id),provider:'catalog',title:String(x.title||'Untitled').slice(0,125),
   aliases:Array.isArray(x.aliases)?[...new Set(x.aliases.filter(Boolean).map(String))].slice(0,10):[],
   year:Number(x.year)||null,numberOfEpisodes:Number(x.numberOfEpisodes)||null,
   format:FORMATS.has(x.format)?x.format:null,status:STATUSES.has(x.status)?x.status:null,popularity:Number(x.popularity)||0,
   poster:typeof x.poster==='string'?x.poster:'',languages:[],availability:'catalog-only',catalogSource:x.catalogSource
 })).filter(x=>{if(seen.has(x.id))return false;seen.add(x.id);return true}).slice(0,20)
}
export async function searchAnimeCatalog(query,{fetcher=fetch,timeoutMs=6000}={}){
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
      aliases:[m.title?.english,m.title?.romaji,m.title?.native,...(m.synonyms||[]).slice(0,6)],poster:m.coverImage?.large,year:m.seasonYear||m.startDate?.year,numberOfEpisodes:m.episodes,format:m.format,status:m.status,popularity:m.popularity,catalogSource:'AniList'}))),source:'AniList',errors};
 }catch(e){errors.push(`AniList: ${/HTTP \d+/.test(e.message||'')?e.message:'unavailable or timed out'}`)}
 // Jikan is a second independent catalog; unlike a stream site it only provides metadata.
 try{
   const url='https://api.jikan.moe/v4/anime?q='+encodeURIComponent(q)+'&limit=20&sfw=true';
   const res=await fetcher(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
   if(!res.ok)throw new Error(`HTTP ${res.status}`);
   const data=await res.json();if(!Array.isArray(data.data))throw new Error('Invalid response');
   return {results:safeItems(data.data.map(m=>({id:`catalog:jikan:${m.mal_id}`,title:m.title_english||m.title,
      aliases:[m.title,m.title_english,m.title_japanese,...(m.titles||[]).map(x=>x.title).slice(0,6)],poster:m.images?.jpg?.large_image_url,year:m.year||Number(m.aired?.from?.slice(0,4)),numberOfEpisodes:m.episodes,format:JIKAN_FORMAT[String(m.type||'').toLowerCase()],status:/finished/i.test(m.status||'')?'FINISHED':/currently/i.test(m.status||'')?'RELEASING':/not yet/i.test(m.status||'')?'NOT_YET_RELEASED':null,popularity:m.members||0,catalogSource:'Jikan'}))),source:'Jikan',errors};
 }catch(e){errors.push(`Jikan: ${/HTTP \d+/.test(e.message||'')?e.message:'unavailable or timed out'}`)}
 return {results:[],source:null,errors};
}
