import type {Title} from './model.js';

/**
 * Anime sources list every season as its own title ("Dr. Stone", "Dr. Stone: Stone Wars", ...).
 * These helpers group the titles from one search into a family and number the seasons, so the panel can
 * say "Season 2 · Episode 5 of 11" and offer a season dropdown without any extra network requests.
 */
const norm=(s:string)=>s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const SPECIAL=/\b(movie|film|ova|oad|special|specials|recap|gaiden|picture drama)\b/;
const ROMAN:Record<string,number>={ii:2,iii:3,iv:4,v:5,vi:6};

/** The title without season/part markers, used to decide which titles belong together. */
export function baseKey(title:string):string{
  return norm(title)
    .replace(/\b\d+(st|nd|rd|th) season\b/g,' ').replace(/\bseason \d+\b/g,' ').replace(/\b(part|cour) \d+\b/g,' ')
    .replace(/\b(the )?final season\b/g,' ').replace(/\b(ii|iii|iv|vi|v)\b$/,' ').trim().replace(/ \d+$/,'')
    .replace(/\s+/g,' ').trim();
}
/** A season number written in the title itself, or null. */
export function explicitSeason(title:string):number|null{
  const n=norm(title);
  let m=n.match(/\bseason (\d+)\b/)||n.match(/\b(\d+)(?:st|nd|rd|th) season\b/);
  if(m)return Number(m[1]);
  m=n.match(/ (ii|iii|iv|vi|v)$/);if(m)return ROMAN[m[1]!]!;
  m=n.match(/^(.*[a-z]) (\d)$/);if(m&&Number(m[2])>=2)return Number(m[2]);
  return null;
}
export const isSpecial=(title:string)=>SPECIAL.test(norm(title));

type Hint={year?:number;count?:number};
function hintsFor(all:Array<Title&Hint>):Map<string,Hint>{
  const map=new Map<string,Hint>();
  for(const t of all)for(const name of [t.title,...(t.aliases||[])]){
    if(!name)continue;const key=norm(name);const have=map.get(key)||{};
    map.set(key,{year:have.year??t.year,count:have.count??t.count});
  }
  return map;
}

/** The seasons of the anime the person picked, in watching order. Empty when it has no siblings. */
export function buildFamily(selected:Title,rows:Title[],everything:Title[]=rows):Title[]{
  const key0=baseKey(selected.title);
  if(key0.length<3)return [];
  const near=rows.filter(r=>{const k=baseKey(r.title);return k.length>=3&&(k.startsWith(key0)||key0.startsWith(k))});
  if(near.length<2)return [];
  const root=near.map(r=>baseKey(r.title)).sort((a,b)=>a.length-b.length)[0]!;
  const hints=hintsFor(everything as Array<Title&Hint>);
  const members=near.filter(r=>baseKey(r.title).startsWith(root)).map((r,index)=>{
    const h=[r.title,...(r.aliases||[])].map(n=>hints.get(norm(n))).find(x=>x?.year||x?.count)||{};
    return {r,index,year:(r as Title&Hint).year??h.year,count:(r as Title&Hint).count??h.count,explicit:explicitSeason(r.title),special:isSpecial(r.title)};
  });
  if(members.length<2)return [];
  const main=members.filter(m=>!m.special),extra=members.filter(m=>m.special);
  const years=main.length>0&&main.every(m=>m.year);
  main.sort((a,b)=>years?(a.year!-b.year!)||((a.explicit??0)-(b.explicit??0)):((a.explicit??1)-(b.explicit??1))||a.index-b.index);
  // Use the numbers the titles state only when they are all different; otherwise count in order.
  const stated=main.map(m=>m.explicit).filter((n):n is number=>n!==null);
  const useStated=stated.length>0&&new Set(stated).size===stated.length&&stated.length>=main.length-1;
  const out:Title[]=[];
  main.forEach((m,n)=>out.push({id:m.r.id,provider:m.r.provider,title:m.r.title,poster:m.r.poster,aliases:m.r.aliases,year:m.year,count:m.count,
    season:useStated?(m.explicit??1):n+1}));
  for(const m of extra)out.push({id:m.r.id,provider:m.r.provider,title:m.r.title,poster:m.r.poster,aliases:m.r.aliases,year:m.year,count:m.count,season:0});
  return out.slice(0,24);
}

/** Attach the season family to a title picked from a search. */
export function withFamily(title:Title,rows:Title[],everything:Title[]=rows):Title{
  const family=buildFamily(title,rows,everything);
  if(!family.length)return title;
  const self=family.find(f=>f.id===title.id&&f.provider===title.provider)||family.find(f=>norm(f.title)===norm(title.title));
  return {...title,family,season:self?.season,year:title.year??self?.year,count:title.count??self?.count};
}

/** "Season 2", "Special", or '' when unknown. */
export function seasonText(title?:Title):string{
  if(!title||title.season===undefined)return '';
  return title.season===0?'Special':`Season ${title.season}`;
}
