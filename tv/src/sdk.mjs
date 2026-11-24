// Provider adapter: site-specific network scrapers are owned by the anime-sdk package.
import {filterSourceSearchResults} from './playback.mjs';
import {resolveMegaPlayV2} from './megaplay-v2.mjs';
import {AniNekoProvider} from './anineko.mjs';
import {ExtraProvider,EXTRA_IDS} from './extra-providers.mjs';
import {HiAnimeProvider} from './hianime.mjs';
import {KNOWN_LANGUAGES} from './availability.mjs';
// Nothing in this app bypasses DRM or tries to defeat provider restrictions.
const CLASS_MAP = {
  animeparadise:'AnimeParadiseProvider', allmanga:'AllmangaProvider',
  megaplay:'MegaPlayProvider', anikoto:'AnikotoProvider',
  gogoanime:'GogoanimeProvider', goyabu:'GoyabuProvider'
};
export async function bounded(promise,ms){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Provider timed out')),ms)})])}finally{clearTimeout(timer)}
}
let constructed=null;
let sharedHttp=null;
export async function getProviders() {
  if(constructed) return constructed;
  let sdk;
  try { sdk=await import('anime-sdk') } catch(e) {throw new Error('anime-sdk not installed. Run INSTALL-CAMELOT-TV.bat or npm install first.')}
  const http=new sdk.HttpClient({timeoutMs:16000});
  sharedHttp=http;
  const enabled=(process.env.CAMELOT_PROVIDERS||'hianime,animeparadise,anikoto,megaplay,anineko,allmanga,gogoanime,goyabu,animepahe,animekai,kickassanime').split(',').map(x=>x.trim()).filter(x=>CLASS_MAP[x]||x==='anineko'||x==='hianime'||EXTRA_IDS.includes(x));
  const out=new Map();
  for(const id of enabled) { if(EXTRA_IDS.includes(id))out.set(id,new ExtraProvider(id)); else if(id==='hianime')out.set(id,new HiAnimeProvider()); else if(id==='anineko')out.set(id,new AniNekoProvider()); else if(typeof sdk[CLASS_MAP[id]]==='function') out.set(id,new sdk[CLASS_MAP[id]](http)); }
  if(!out.size) throw new Error('No anime content provider classes found in installed anime-sdk package');
  constructed=out;
  return out;
}
import {settleWithGrace} from './grace.mjs';
import {health,classifyFailure} from './health.mjs';
export async function searchCatalog(q,which='all') {
  const p=await getProviders();
  let targets=which==='all'?[...p.entries()]:[[which,p.get(which)]].filter(x=>x[1]);
  if(!targets.length)throw new Error('Unknown provider');
  // A source that keeps failing (dead DNS name, timeouts) sits out for a while instead of costing a timeout on every search.
  const skipped=[];
  if(which==='all'){const live=targets.filter(([key])=>!health.coolingDown(key));if(live.length){for(const [key] of targets)if(!live.some(x=>x[0]===key))skipped.push(key);targets=live}}
  const settled=await settleWithGrace(targets.map(async([key,instance])=>{
    // One dead or slow source must not hold up the whole search: 11 run in parallel and the
    // slowest used to decide the wait (12+ seconds every time). Tunable with PROVIDER_SEARCH_MS.
    const budget=Math.max(3000,Number(process.env.PROVIDER_SEARCH_MS)||7000);
    const ac=AbortSignal.timeout(budget);
    const began=Date.now();
    let rows;
    try{rows=await bounded(instance.search(q,{signal:ac}),budget+1500)}
    catch(error){health.failure(key,error,{ms:Date.now()-began});throw error}
    health.success(key,{ms:Date.now()-began});
    return (Array.isArray(rows)?rows:[]).filter(r=>r && typeof r.id==='string' && r.id.startsWith(key+':'))
      .slice(0,12).map(r=>({id:r.id,provider:key,title:String(r.title||'Untitled').slice(0,125),
        poster:typeof r.thumbnailUrl==='string'?r.thumbnailUrl:'',year:r.year??null,
        languages:Array.isArray(r.availableLanguages)?r.availableLanguages:[]}));
  }),{graceMs:Number(process.env.SEARCH_GRACE_MS)||3000,isGood:rows=>rows.length>0});
  const results=filterSourceSearchResults(q,settled.flatMap(x=>x.status==='fulfilled'?x.value:[]));
  const failures=settled.map((x,i)=>{
    if(x.status!=='rejected')return null;
    const msg=String(x.reason?.message||'').slice(0,300);
    const code=msg.match(/(?:HTTP|status|error)\s*(4\d\d|5\d\d)/i)?.[1];
    const cls=classifyFailure(x.reason);
    return {provider:targets[i][0],class:cls,reason:code?`HTTP ${code}`:cls==='dns'?'host not found':/abort|timeout|timed out/i.test(msg)?'timed out':/fetch|network|dns|connect/i.test(msg)?'network error':'source unavailable'};
  }).filter(Boolean);
  for(const key of skipped)failures.push({provider:key,class:'cooldown',reason:'skipped after repeated failures'});
  return {results,failures};
}
export async function listEpisodes(provider,id) {
  const p=(await getProviders()).get(provider);
  if(!p || typeof id!=='string'||!id.startsWith(provider+':')||id.length>600)throw new Error('Invalid title/provider');
  const rows=await bounded(p.fetchContentUnits(id,{signal:AbortSignal.timeout(14000)}),15000);
  if(!Array.isArray(rows)) throw new Error('Provider did not return an episode list');
  return rows.filter(r=>r && typeof r.id==='string' && r.id.startsWith(provider+':'))
    .slice(0,1000).map(r=>({id:r.id,title:String(r.title||`Episode ${r.number}`).slice(0,140),
      number:Number(r.number),languages:Array.isArray(r.availableLanguages)?r.availableLanguages:[],
      subtitles:Array.isArray(r.availableSubtitles)?r.availableSubtitles.map(s=>s.label).slice(0,6):[]}));
}
export async function resolveEpisode(provider,unitId,lang='sub') {
  if(KNOWN_LANGUAGES[provider]&&!KNOWN_LANGUAGES[provider].includes(lang))throw new Error(`${provider} does not support ${lang.toUpperCase()}; checking other sources`);
  const p=(await getProviders()).get(provider);
  if(!p || typeof unitId!=='string'||!unitId.startsWith(provider+':')||unitId.length>700)throw new Error('Invalid episode/provider');
  // MegaPlay switched from its old plaintext getSources endpoint to getSourcesNew.
  // Use the newer source format first; the installed anime-sdk path remains a fallback.
  let newerFailure='';
  if(provider==='megaplay'||provider==='anikoto'){
    try {return await resolveMegaPlayV2(provider,unitId,lang,sharedHttp)}
    catch(e){
      newerFailure=String(e?.message||'new player unavailable').replace(/https?:\/\/[^\s]+/g,'[host]');
      // Treat access denial as authoritative instead of repeatedly hitting the same host.
      if(/HTTP (?:401|403|429)|denied access/i.test(newerFailure))throw new Error(newerFailure);
    }
  }
  try {
    const result=await bounded(p.resolveStream(unitId,lang,{signal:AbortSignal.timeout(26000)}),28000);
    if(result?.type!=='video'||!Array.isArray(result.streams))throw new Error('Provider did not supply a video stream');
    // AnimeParadise serves its HLS playlist with Origin + Referer (per current player).
    if(provider==='animeparadise')return result.streams.map(s=>({...s,headers:{...s.headers,
      Referer:'https://animeparadise.moe/',Origin:'https://animeparadise.moe'}}));
    if(provider==='goyabu')return result.streams.map(s=>({...s,language:'raw'}));
    return result.streams;
  } catch(e) {
    if(newerFailure)throw new Error(`Updated MegaPlay failed: ${newerFailure}; old source API failed as well`);
    throw e;
  }
}
