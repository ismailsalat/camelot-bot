import type {Episode} from './model.js';

/**
 * What a person typed into "Go to episode": 206, "ep 206", "e206", "#206", "+5" / "-3" (from the current one),
 * or "last". Returns the index into `episodes`, or throws a message that says what is wrong and what IS available.
 */
export function parseEpisodeInput(raw:string,episodes:Episode[],current:number):number{
  if(!episodes.length)throw new Error('No episodes are loaded yet. Choose an anime first.');
  const numbers=episodes.map(e=>e.number);
  const first=Math.min(...numbers),last=Math.max(...numbers);
  const range=first===last?`episode ${first}`:`episodes ${first}–${last}`;
  const text=String(raw||'').trim().toLowerCase().replace(/\s+/g,' ');
  if(!text)throw new Error(`Type an episode number (this anime has ${range}).`);
  if(/^(last|final|end|max|latest)$/.test(text))return numbers.indexOf(last);
  if(/^(first|start|beginning)$/.test(text))return numbers.indexOf(first);
  const rel=/^([+-])\s*(\d{1,4})$/.exec(text);
  if(rel){
    const target=episodes[current]?.number!+(rel[1]==='-'?-1:1)*Number(rel[2]);
    if(target>last)throw new Error(`Only ${last-episodes[current]!.number} episode${last-episodes[current]!.number===1?'':'s'} left after this one (the last is ${last}).`);
    if(target<first)throw new Error(`There are only ${episodes[current]!.number-first} episode${episodes[current]!.number-first===1?'':'s'} before this one (the first is ${first}).`);
    return nearest(numbers,target,range,true);
  }
  const m=/^(?:episode|ep|e|#|no\.?)?\s*(\d{1,4})$/.exec(text);
  if(!m)throw new Error(`"${String(raw).trim().slice(0,30)}" is not an episode number. Type something like 206 (this anime has ${range}).`);
  const n=Number(m[1]);
  if(n>last)throw new Error(`Episode ${n} doesn't exist. The last episode is ${last}.`);
  if(n<first)throw new Error(`Episode ${n} doesn't exist. This anime starts at episode ${first}.`);
  return nearest(numbers,n,range,false);
}
function nearest(numbers:number[],n:number,range:string,relative:boolean):number{
  const at=numbers.indexOf(n);
  if(at>=0)return at;
  // Inside the range, but the sources do not list it (a gap): say which neighbours exist.
  const below=Math.max(...numbers.filter(x=>x<n)),above=Math.min(...numbers.filter(x=>x>n));
  throw new Error(`Episode ${n} isn't listed by the sources${relative?'':` (they list ${range} with a gap here)`}. Closest: ${[below,above].filter(Number.isFinite).join(' or ')}.`);
}
