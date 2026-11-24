import {sameAnime} from './catalog.mjs';
import {settleWithGrace} from './grace.mjs';

export const LANGUAGES=['sub','dub','raw'];
export const KNOWN_LANGUAGES={animeparadise:['sub'],gogoanime:['sub'],goyabu:['raw']};
export function episodeLanguages(episode,provider) {
  // Some SDK adapters label every episode "sub" even for Portuguese audio.
  if(KNOWN_LANGUAGES[provider])return KNOWN_LANGUAGES[provider];
  const listed=(episode?.languages||[]).filter(x=>LANGUAGES.includes(x));
  return listed;
}
export function matchingSources(original,candidates) {
  const seen=new Set();
  return candidates.filter(x=>{
    const key=`${x.provider}:${x.id}`;
    if(x.provider==='catalog'||!sameAnime(original,x)||seen.has(key))return false;
    seen.add(key);return true;
  });
}
export async function inspectSources(original,candidates,list,{graceMs=0}={}) {
  const items=matchingSources(original,candidates);
  const tasks=items.map(async item=>{
    try {
      const episodes=await list(item.provider,item.id);
      return {provider:item.provider,media:item.id,status:'checked',episodes:episodes.map(e=>({...e,languages:episodeLanguages(e,item.provider)}))};
    } catch {
      return {provider:item.provider,media:item.id,status:'unavailable',episodes:[]};
    }
  });
  // The slowest source used to decide how long loading took. Once one source has listed episodes the
  // others get a short grace period; stragglers keep running and are cached for the Play step.
  const settled=await settleWithGrace(tasks,{graceMs,isGood:row=>row.status==='checked'});
  return settled.map((x,i)=>x.status==='fulfilled'?x.value:{provider:items[i].provider,media:items[i].id,status:'unavailable',episodes:[]});
}
export function languageAvailability(rows,number,language) {
  const listed=[],unknown=[];
  for(const row of rows){
    if(row.status!=='checked'){unknown.push(row.provider);continue;}
    const matching=row.episodes.filter(e=>Number(e.number)===Number(number));
    if(matching.some(e=>e.languages.includes(language)))listed.push(row.provider);
    else if(matching.some(e=>!e.languages.length))unknown.push(row.provider);
  }
  return {status:listed.length?'listed':unknown.length?'unknown':'not-listed',
    providers:[...new Set(listed)],unknown:[...new Set(unknown)]};
}
export function episodeMenu(rows,{incomplete=false}={}) {
  const episodes=new Map();
  for(const row of rows) for(const ep of row.episodes){
    if(!Number.isFinite(ep.number)||ep.number<0)continue;
    if(!episodes.has(ep.number))episodes.set(ep.number,{id:`episode:${ep.number}`,number:ep.number,title:ep.title||`Episode ${ep.number}`});
  }
  return [...episodes.values()].sort((a,b)=>a.number-b.number).map(ep=>{
    const availability=Object.fromEntries(LANGUAGES.map(l=>{
      const a=languageAvailability(rows,ep.number,l);
      if(incomplete&&a.status==='not-listed')a.status='unknown';
      return [l,a];
    }));
    return {...ep,languages:LANGUAGES.filter(l=>availability[l].status==='listed'),availability};
  });
}
