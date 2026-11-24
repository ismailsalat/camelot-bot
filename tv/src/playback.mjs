// Candidate planning and execution for online episodes. No source URLs are logged.
// Search listings are not proof of playable video. Never switch to a different season.
import {normTitle, sameAnime} from './catalog.mjs';
import {episodeLanguages} from './availability.mjs';

const PROVIDER_PREFERENCE = ['animeparadise','anikoto','megaplay','anineko','allmanga','gogoanime','goyabu'];
export const preference = provider => {
  const index=PROVIDER_PREFERENCE.indexOf(provider);
  return index < 0 ? 99 : index;
};
const allowedLanguages = (item, lang) => {
  const langs = episodeLanguages(item,item?.provider);
  return !langs.length || langs.includes(lang);
};

export function candidatePlan(primary, original, candidates, language='sub') {
  if (!primary?.provider || (!primary?.unit&&!primary?.media) || !original?.title) throw new Error('Choose a title and episode');
  // Exact normalized title (or a catalog alias) is mandatory. No substring/season fallback.
  // Deduplicate by provider so we cannot keep retrying the same broken host.
  const seen=new Set([`${primary.provider}:${primary.media||original.id}`]);
  const other=[];
  for (const item of candidates||[]) {
    if (!item || item.provider==='catalog' || seen.has(`${item.provider}:${item.id}`)) continue;
    if (!sameAnime(original,item)) continue;
    seen.add(`${item.provider}:${item.id}`);
    other.push({provider:item.provider,media:item.id,alt:true});
  }
  other.sort((a,b)=>preference(a.provider)-preference(b.provider));
  return [{...primary,alt:primary.alt||!primary.unit},...other];
}

export function filterSourceSearchResults(query, items) {
  const q=normTitle(query);
  if (q.length<2) return [];
  return (items||[]).filter(item=>{
    const title=normTitle(item?.title);
    // Match title words, not a partial token ("dr stone" must not match "Dragon").
    return title===q || title.startsWith(q+' ') || title.includes(' '+q+' ');
  });
}

const withTimeout=(promise,ms,message)=>{
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms)})]).finally(()=>clearTimeout(timer));
};

/**
 * Find a source that really plays. Listing and resolving are network-only, so up to `concurrency` providers do
 * that at the same time (each with its own timeout); the FFmpeg check runs for ONE provider at a time, in queue
 * order among those that are ready, so validation never competes with the running stream for CPU.
 * Providers on cooldown (repeated provider-level failures) are skipped unless nothing else is left.
 */
export async function tryPlayableEpisode({queue, episode, language, list, resolve, rank, probe, prepare=async source=>source, discard=async()=>{}, onProgress=()=>{}, onSuccess, shouldStop=()=>false, health=null, concurrency=3, providerTimeoutMs=9000, onEvent=()=>{}, clock=()=>performance.now()}) {
  const failures=[];
  const number=Number(episode?.number);
  if (!Number.isFinite(number) || number<0) throw new Error('Invalid episode number');
  const seenKeys=new Set();
  let entries=(queue||[]).filter(entry=>{const key=`${entry.provider}:${entry.media||entry.unit}`;if(seenKeys.has(key))return false;seenKeys.add(key);return true});
  if(health){
    const cooling=entries.filter(e=>!e.pinned&&health.coolingDown(e.provider));
    const usable=entries.filter(e=>!cooling.includes(e));
    for(const e of cooling){
      failures.push({provider:e.provider,reason:'Skipped: cooling down after repeated failures',class:'cooldown'});
      onProgress(`${e.provider}: skipped (cooling down after repeated failures)`);
    }
    entries=usable.length?usable:entries;   // never end up with nothing to try
  }
  const fail=(entry,error,ms)=>{
    const reason=String(error?.message||error||'Provider unavailable');
    const cls=health?health.failure(entry.provider,error,{ms}):undefined;
    failures.push({provider:entry.provider,reason,class:cls});
    onEvent({ev:'provider_failed',provider:entry.provider,cls,ms:Math.round(ms)});
  };
  const resolveStage=async(entry)=>{
    const started=clock();
    onEvent({ev:'provider_resolve_start',provider:entry.provider});
    const work=(async()=>{
      let unit=entry.unit;
      if (entry.alt) {
        onProgress(`Checking ${entry.provider}: matching episode ${number}...`);
        const episodes=await list(entry.provider,entry.media);
        const matching=(episodes||[]).filter(e=>Number(e.number)===number && allowedLanguages({...e,provider:entry.provider},language));
        if (matching.length!==1)throw new Error(matching.length?'Ambiguous episode matching':'Requested episode/language unavailable');
        unit=matching[0].id;
      }
      else if(!allowedLanguages({...episode,provider:entry.provider},language))throw new Error(`This source does not list ${language.toUpperCase()}; checking other sources`);
      if (!unit)throw new Error('No matching episode ID');
      onProgress(`Resolving episode ${number} with ${entry.provider}...`);
      const resolved=await resolve(entry.provider,unit,language);
      const streams=rank(resolved,language);
      if (!streams.length)throw new Error('No direct HTTPS video URL returned');
      return streams;
    })();
    work.catch(()=>{});   // a timed-out lookup may still fail later; nobody is waiting for it any more
    const streams=await withTimeout(work,providerTimeoutMs,`${entry.provider} did not answer within ${Math.round(providerTimeoutMs/1000)}s (timed out)`);
    onEvent({ev:'provider_resolve_done',provider:entry.provider,ms:Math.round(clock()-started)});
    return {streams,resolveMs:clock()-started};
  };
  const validate=async(entry,streams,resolveMs)=>{
    let last='No playable video frame';
    const seenStreams=new Set();
    for (const source of streams.slice(0,8)) {
      if(source.language&&source.language!==language)continue;
      if(seenStreams.has(source.url))continue;
      seenStreams.add(source.url);
      if (shouldStop()) throw new Error('Video check cancelled');
      let prepared;const started=clock();
      try {
        prepared=await prepare(source,entry);
        onProgress(`Testing ${entry.provider} ${source.quality} with FFmpeg...`);
        onEvent({ev:'validate_start',provider:entry.provider});
        await probe(source.url,source.headers,source.isHLS,prepared);
        if (shouldStop())throw new Error('Video check cancelled');
        const validateMs=Math.round(clock()-started);
        onEvent({ev:'validate_done',provider:entry.provider,ms:validateMs});
        onProgress(`Verified real video from ${entry.provider}`);
        await onSuccess(prepared,entry,{resolveMs:Math.round(resolveMs),validateMs});
        health?.success(entry.provider,{ms:resolveMs+validateMs,language,format:source.isHLS?'hls':'file'});
        return {provider:entry.provider,quality:source.quality,subtitle:prepared.subtitleStatus,failures,resolveMs:Math.round(resolveMs),validateMs};
      } catch(e) {
        if(prepared)await discard(prepared);
        last=String(e?.message||'Video test failed');
        if (/cancelled/i.test(last))throw e;
        onProgress(`${entry.provider}: ${last}`);
        if (/HTTP 429/.test(last))break; // Do not hammer a rate-limited CDN.
      }
    }
    throw new Error(last);
  };

  let next=0,finished=false;const inflight=new Map();const ready=[];
  const launch=()=>{
    while(inflight.size<Math.max(1,concurrency)&&next<entries.length){
      const index=next++,entry=entries[index];
      if(shouldStop())throw new Error('Video check cancelled');
      const started=clock();
      const p=resolveStage(entry).then(value=>({index,entry,ok:true,value,started}),error=>({index,entry,ok:false,error,started}));
      inflight.set(index,p);
      p.then(result=>{
        inflight.delete(index);
        // A provider that is still answering after another one already won must still be accounted for, otherwise a dead
        // provider early in the list would never cool down.
        if(finished){if(!result.ok&&!/cancelled/i.test(String(result.error?.message)))fail(result.entry,result.error,clock()-result.started);return}
        ready.push(result);
      });
    }
  };
  try{
  launch();
  while(inflight.size||ready.length){
    if(shouldStop()) throw new Error('Video check cancelled');
    if(!ready.length){await Promise.race([...inflight.values()]);continue}
    ready.sort((a,b)=>a.index-b.index);
    const item=ready.shift();
    if(!item.ok){
      const reason=String(item.error?.message||item.error);
      if (/cancelled/i.test(reason))throw item.error;
      fail(item.entry,item.error,clock()-item.started);onProgress(`${item.entry.provider}: ${reason}`);launch();continue;
    }
    try{
      return await validate(item.entry,item.value.streams,item.value.resolveMs);
    }catch(e){
      const reason=String(e?.message||'Provider unavailable');
      if (/cancelled/i.test(reason))throw e;
      fail(item.entry,e,clock()-item.started);
      launch();
    }
  }
  const summary=failures.map(f=>`${f.provider}: ${f.reason}`).join(' | ');
  const error=new Error('No playable video found from the matching sources. '+summary);
  error.failures=failures;
  throw error;
  }finally{finished=true}
}

/**
 * The providers that may play this episode: only listings already verified as the chosen anime, only those that list the
 * requested language for this episode number. A different version of the anime (or the other language) is never queued.
 * The provider the user was already on goes first, the rest follow in preference order.
 */
export function verifiedPlan(accepted, primary, number, language='sub') {
  const out=[], seen=new Set();
  for (const row of accepted||[]) {
    const key=`${row.provider}:${row.media}`;
    if (seen.has(key)) continue;
    const eps=(row.episodes||[]).filter(e=>Number(e.number)===Number(number));
    if (!eps.length) continue;
    if (!eps.some(e=>allowedLanguages(e,language))) continue;
    seen.add(key);out.push({provider:row.provider,media:row.media,alt:true});
  }
  out.sort((a,b)=>(Number(b.provider===primary?.provider&&b.media===primary?.media)-Number(a.provider===primary?.provider&&a.media===primary?.media))||preference(a.provider)-preference(b.provider));
  return out;
}
/** Which languages the verified listings offer for one episode (for a clear error when the requested one is missing). */
export function offeredLanguages(accepted, number) {
  const langs=new Set();
  for (const row of accepted||[]) for (const e of (row.episodes||[]).filter(x=>Number(x.number)===Number(number))) for (const l of (e.languages||[])) langs.add(l);
  return [...langs];
}
