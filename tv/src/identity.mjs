// Which anime is this, really?  Titles alone cannot say: "Hunter x Hunter" is two different series (1999 and 2011), and
// provider search results carry no year or episode count. This module keeps one *entity* per real anime (taken from the
// catalogue: AniList/Jikan id, year, type, status, episode total) and attaches provider listings to it only when the
// evidence supports it:
//   id          the provider's own id IS the AniList id (MegaPlay)                    -> certain
//   name+year   same title and the release years agree                              -> strong
//   name        same title, and no other entity in the results has that title        -> accepted
//   ambiguous   same title as two or more entities (remakes)                        -> decided later by the episode count
// A listing that cannot be tied to the chosen entity is never played, and every decision is written to a report.
import {baseName,titleYear,normTitle} from './catalog.mjs';

export const FORMAT_LABEL={TV:'TV',TV_SHORT:'TV short',MOVIE:'Movie',SPECIAL:'Special',OVA:'OVA',ONA:'ONA',MUSIC:'Music'};
export function formatGroup(format,title=''){
  if(format==='MOVIE')return 'movie';
  if(['OVA','SPECIAL','MUSIC'].includes(format))return 'other';
  if(['TV','TV_SHORT','ONA'].includes(format))return 'main';
  const n=normTitle(title);                       // provider-only rows: guess from the words
  if(/\b(movie|film|gekijouban)\b/.test(n))return 'movie';
  if(/\b(ova|oad|special|specials|recap|picture drama)\b/.test(n))return 'other';
  return 'main';
}
const namesOf=x=>new Set([x?.title,...(x?.aliases||[])].map(baseName).filter(n=>n.length>=2));
const looseName=n=>n.replace(/\b(?:the movie|movie|film|gekijouban|ova|oad|special)\b/g,' ').replace(/\s+/g,' ').trim();
const yearOf=x=>{const y=Number(x?.year);return y>1950?y:titleYear(x?.title)};
const anilistId=id=>/^catalog:anilist:(\d+)$/.exec(String(id||''))?.[1]||null;
const yearsAgree=(a,b)=>!a||!b||Math.abs(a-b)<=1;
const ratio=(a,b)=>a>0&&b>0?Math.min(a,b)/Math.max(a,b):0;

export function makeEntity(c){
  const year=yearOf(c);
  return {key:c.id,id:c.id,provider:c.provider||'catalog',title:c.title,aliases:c.aliases||[],names:namesOf(c),year,format:c.format||null,
    group:formatGroup(c.format,c.title),status:c.status||null,total:Number(c.numberOfEpisodes)||null,poster:c.poster||'',popularity:c.popularity||0,
    catalogSource:c.catalogSource||null,candidates:[],siblings:[]};
}
function candidateInfo(c){return {provider:c.provider,id:c.id,title:c.title,year:yearOf(c),names:namesOf(c),languages:c.languages||[],poster:c.poster||''}}

/** Attach provider candidates to entities. Mutates `entities` (adds candidates / orphan entities) and returns decisions. */
export function attachCandidates(entities,candidates){
  const decisions=[];
  const have=new Set(entities.flatMap(e=>e.candidates.map(c=>`${c.provider}:${c.id}`)));
  for(const raw of candidates||[]){
    if(!raw||raw.provider==='catalog'||have.has(`${raw.provider}:${raw.id}`))continue;
    const cand=candidateInfo(raw);have.add(`${cand.provider}:${cand.id}`);
    const byId=raw.provider==='megaplay'?/^megaplay:(\d+)$/.exec(raw.id)?.[1]:null;
    const exact=byId?entities.find(e=>anilistId(e.id)===byId):null;
    if(exact){exact.candidates.push({...cand,confirm:'id',ambiguousWith:[]});decisions.push({provider:cand.provider,title:cand.title,entity:exact.key,confirm:'id'});continue}
    let sameName=entities.filter(e=>!e.orphan&&[...cand.names].some(n=>e.names.has(n)));
    if(!sameName.length&&formatGroup(null,cand.title)!=='main'){
      // "Hunter x Hunter Movie: Phantom Rouge" (source) is "Hunter x Hunter: Phantom Rouge" (catalogue): the word Movie is not part of the name.
      const wanted=new Set([...cand.names].map(looseName).filter(n=>n.length>=3));
      sameName=entities.filter(e=>!e.orphan&&e.group!=='main'&&[...e.names].some(n=>wanted.has(looseName(n))));
    }
    const compat=sameName.filter(e=>yearsAgree(e.year,cand.year));
    if(compat.length===1){
      const e=compat[0];const strong=Boolean(cand.year&&e.year);
      e.candidates.push({...cand,confirm:strong?'name+year':'name',ambiguousWith:[]});
      decisions.push({provider:cand.provider,title:cand.title,entity:e.key,confirm:strong?'name+year':'name'});
    }else if(compat.length>1){
      for(const e of compat)e.candidates.push({...cand,confirm:'ambiguous',ambiguousWith:compat.filter(x=>x!==e).map(x=>x.key)});
      decisions.push({provider:cand.provider,title:cand.title,entity:compat.map(e=>e.key).join('|'),confirm:'ambiguous'});
    }else{
      // Not in the catalogue results (or a different year than every catalogue entry): its own entity, merged per title+year.
      const base=[...cand.names][0]||normTitle(cand.title);
      const key=`p:${base}:${cand.year||''}`;
      let e=entities.find(x=>x.key===key);
      if(!e){e=makeEntity({id:key,provider:cand.provider,title:cand.title,year:cand.year,format:null,aliases:[],poster:cand.poster});e.orphan=true;e.key=key;entities.push(e)}
      e.candidates.push({...cand,confirm:'name',ambiguousWith:[]});
      decisions.push({provider:cand.provider,title:cand.title,entity:key,confirm:'own-entity',note:sameName.length?'year differs from the catalogue entries with this title':'not in the catalogue results'});
    }
  }
  for(const e of entities)e.siblings=entities.filter(x=>x!==e&&x.group===e.group&&[...x.names].some(n=>e.names.has(n))).map(x=>x.key);
  return decisions;
}

const relevance=(e,q)=>{
  if(!q)return 0;
  const names=[...e.names];
  if(names.includes(q))return 0;
  if(names.some(n=>n.startsWith(q+' ')))return 1;
  if(names.some(n=>n.includes(' '+q+' ')||n.endsWith(' '+q)))return 2;
  return 3;
};
const GROUP_RANK={main:0,movie:1,other:2};
export function rankEntities(entities,query=''){
  const q=baseName(query);
  return [...entities].sort((a,b)=>
    relevance(a,q)-relevance(b,q)||GROUP_RANK[a.group]-GROUP_RANK[b.group]||
    Number(b.candidates.length>0)-Number(a.candidates.length>0)||b.popularity-a.popularity||(b.year||0)-(a.year||0)||a.title.localeCompare(b.title));
}
/** Name shown to people: adds the year when several entities share one title ("Hunter x Hunter (2011)"). */
export function displayTitle(e,all){
  const clash=all.some(x=>x!==e&&x.group===e.group&&[...x.names].some(n=>e.names.has(n)));
  if(!clash||!e.year||titleYear(e.title))return e.title;
  return `${e.title} (${e.year})`;
}
/** Short line for the picker: "TV · 2011 · 148 eps · 3 sources". */
export function describeEntity(e){
  const parts=[FORMAT_LABEL[e.format]||(e.group==='movie'?'Movie':e.group==='other'?'Special':'')];
  if(e.year)parts.push(String(e.year));
  if(e.total)parts.push(`${e.total} ep${e.total===1?'':'s'}`);
  if(e.status==='RELEASING')parts.push('airing');
  const sources=new Set(e.candidates.map(c=>c.provider)).size;
  parts.push(sources?`${sources} source${sources===1?'':'s'}`:'no sources found yet');
  return parts.filter(Boolean).join(' · ');
}

export function listingStats(episodes){
  const nums=[...new Set((episodes||[]).map(e=>Number(e.number)).filter(n=>Number.isInteger(n)&&n>=1))];
  return {count:nums.length,max:nums.length?Math.max(...nums):0,listed:(episodes||[]).length};
}

/** Decide whether one provider listing is the chosen entity. `byKey` maps entity keys to entities (for ambiguous ones). */
export function verifyCandidate(entity,candidate,stats,byKey=new Map()){
  const out=(accept,reason)=>({accept,reason,provider:candidate.provider,media:candidate.id,title:candidate.title,confirm:candidate.confirm,count:stats.count,max:stats.max});
  if(!stats.count)return out(false,'the source returned no numbered episodes');
  if(candidate.confirm==='id')return out(true,`the source's own id is the AniList id (${anilistId(entity.id)})`);
  if(entity.group!=='main'&&entity.total&&stats.count>Math.max(3,entity.total*3))return out(false,`${stats.count} episodes listed but this is a ${entity.group} with ${entity.total}`);
  if(candidate.confirm==='name+year')return out(true,`same title and year (${candidate.year})`);
  if(candidate.confirm==='name'){
    if(entity.status==='FINISHED'&&entity.total&&ratio(stats.count,entity.total)<0.35)
      return out(false,`${stats.count} episodes listed, the catalogue says ${entity.total}`);
    return out(true,'same title, no other version of it in the results');
  }
  // ambiguous: remakes share a title, so the episode count has to decide
  const siblings=(candidate.ambiguousWith||[]).map(k=>byKey.get(k)).filter(Boolean);
  const mine=entity.total?ratio(stats.count,entity.total):null;
  const sib=siblings.map(s=>({s,r:s.total?ratio(stats.count,s.total):null}));
  const bestSib=sib.filter(x=>x.r!==null).sort((a,b)=>b.r-a.r)[0];
  if(mine===null){
    if(bestSib&&bestSib.r>=0.75)return out(false,`${stats.count} episodes matches "${bestSib.s.title}" (${bestSib.s.total})`);
    return out(true,'catalogue total unknown, and no other version fits better');
  }
  if(mine>=0.75&&(!bestSib||mine>=bestSib.r+0.05))return out(true,`${stats.count} episodes fits ${entity.total}${bestSib?` better than "${bestSib.s.title}" (${bestSib.s.total})`:''}`);
  if(bestSib&&bestSib.r>mine&&bestSib.r>=0.75)return out(false,`${stats.count} episodes fits "${bestSib.s.title}" (${bestSib.s.total}) better than ${entity.total}`);
  if(entity.status==='RELEASING'&&stats.count<=entity.total&&(!bestSib||bestSib.r<0.5))return out(true,`airing: ${stats.count} of ${entity.total} released so far`);
  return out(false,`cannot tell the versions apart: ${stats.count} episodes listed, expected ${entity.total}${bestSib?` or ${bestSib.s.total}`:''}`);
}

/** One readable line per decision, for logs and the diagnostics export. */
export function reportLines(entity,results){
  const head=`Match report for "${entity.title}" (${entity.key}${entity.year?`, ${entity.year}`:''}${entity.format?`, ${FORMAT_LABEL[entity.format]||entity.format}`:''}${entity.total?`, ${entity.total} eps`:''}${entity.status?`, ${entity.status.toLowerCase()}`:''})`;
  return [head,...results.map(r=>`  ${r.pending?'PENDING':r.accept?'ACCEPT':'REJECT'} ${r.provider} "${String(r.title).slice(0,50)}" [${r.confirm}] ${r.count} eps: ${r.reason}`)];
}

/** The rows the picker shows: one per real anime, in order, each saying what it is and which sources carry it. */
export function searchRows(entities,query='',limit=20){
  const ranked=rankEntities(entities,query).slice(0,limit);
  return ranked.map(e=>{
    const first=e.candidates[0];
    const row=e.orphan&&first?{provider:first.provider,id:first.id}:{provider:'catalog',id:e.id};
    return {entity:e,row:{...row,title:displayTitle(e,entities),aliases:e.aliases,year:e.year,numberOfEpisodes:e.total,format:e.format,status:e.status,group:e.group,
      poster:e.poster||first?.poster||'',languages:[],availability:e.candidates.length?'source-candidate':'catalog-only',catalogSource:e.catalogSource,
      sources:[...new Set(e.candidates.map(c=>c.provider))],description:describeEntity(e),entity:e.key}};
  });
}
