// Candidate planning and execution for online episodes. No source URLs are logged.
// Search listings are not proof of playable video. Never switch to a different season.
import {normTitle, sameAnime} from './catalog.mjs';
import {episodeLanguages} from './availability.mjs';

const PROVIDER_PREFERENCE = ['animeparadise','anikoto','megaplay','anineko','allmanga','gogoanime','goyabu'];
const preference = provider => {
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

export async function tryPlayableEpisode({queue, episode, language, list, resolve, rank, probe, prepare=async source=>source, discard=async()=>{}, onProgress=()=>{}, onSuccess, shouldStop=()=>false}) {
  const failures=[];
  const attempted=new Set();
  const number=Number(episode?.number);
  if (!Number.isFinite(number) || number<0) throw new Error('Invalid episode number');
  for (const entry of queue) {
    if (shouldStop()) throw new Error('Video check cancelled');
    const key=`${entry.provider}:${entry.media||entry.unit}`;
    if (attempted.has(key))continue;
    attempted.add(key);
    let unit=entry.unit;
    try {
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
      let last='No playable video frame';
      const seenStreams=new Set();
      for (const source of streams.slice(0,8)) {
        if(source.language&&source.language!==language)continue;
        if(seenStreams.has(source.url))continue;
        seenStreams.add(source.url);
        if (shouldStop()) throw new Error('Video check cancelled');
        let prepared;
        try {
          prepared=await prepare(source,entry);
          onProgress(`Testing ${entry.provider} ${source.quality} with FFmpeg...`);
          await probe(source.url,source.headers,source.isHLS,prepared);
          if (shouldStop())throw new Error('Video check cancelled');
          onProgress(`Verified real video from ${entry.provider}`);
          await onSuccess(prepared,entry);
          return {provider:entry.provider,quality:source.quality,subtitle:prepared.subtitleStatus,failures};
        } catch(e) {
          if(prepared)await discard(prepared);
          last=String(e?.message||'Video test failed');
          if (/cancelled/i.test(last))throw e;
          onProgress(`${entry.provider}: ${last}`);
          if (/HTTP 429/.test(last))break; // Do not hammer a rate-limited CDN.
        }
      }
      failures.push({provider:entry.provider,reason:last});
    } catch(e) {
      const reason=String(e?.message||'Provider unavailable');
      if (/cancelled/i.test(reason))throw e;
      failures.push({provider:entry.provider,reason});
      onProgress(`${entry.provider}: ${reason}`);
    }
  }
  const summary=failures.map(f=>`${f.provider}: ${f.reason}`).join(' | ');
  const error=new Error('No playable video found from the matching sources. '+summary);
  error.failures=failures;
  throw error;
}
