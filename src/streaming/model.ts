export interface Title {
  id:string;provider:string;title:string;poster?:string;aliases?:string[];
  /** Release year and episode total when the catalog knows them. */
  year?:number;count?:number;
  /** Season number within its family (0 = movie/special); set when other seasons were found in the search. */
  season?:number;
  /** The other seasons found in the same search, in watching order. */
  family?:Title[];
  /** From the TV service's catalogue match: TV/MOVIE/OVA/..., airing status, the providers that carry it, and a one-line summary for the picker. */
  format?:string;status?:string;sources?:string[];description?:string;
  /** The one real anime this row is (the TV service verifies every source listing against it). */
  entity?:string;
}
export interface Episode {id:string;number:number;title:string;languages?:string[];availability?:Record<string,{status:string;providers?:string[]}>}
export type Phase='idle'|'loading'|'playing'|'paused'|'offline'|'error';
export interface Session {
  id:string;guild:string;channel:string;message?:string;owner:string|null;
  title?:Title;episodes:Episode[];episode:number;sources:string[];source:string;actualSource?:string;
  /** When the on-stream countdown ends (ms since epoch); the panel shows a live Discord countdown until then. */
  countdownUntil?:number;
  /** What happened to subtitles on the last start: 'burned' (English subtitles are in the picture), or the reason there are none. */
  subtitle?:string;
  lang:'sub'|'dub';phase:Phase;position:number;duration:number|null;changed:number;note:string;
  /** Anime waiting to play after the current one, in order. */
  queue?:Title[];
  /** Video size being streamed, and whether the current source also offers 1080p. */
  quality?:'720p'|'1080p';hd?:boolean;
  /** Which page of the episode dropdown is showing (long shows only). */
  epPage?:number;
}
export function seconds(text:string, current=0):number {
  const s=text.trim();
  if(!/^[+-]?(?:\d{1,6}|\d{1,3}:\d{2}(?::\d{2})?)$/.test(s))throw new Error('Use seconds, mm:ss, or +30 / -30.');
  const sign=s.startsWith('-')?-1:1;
  const parts=s.replace(/^[+-]/,'').split(':').map(Number);
  if(parts.slice(1).some(n=>n>=60))throw new Error('Minutes and seconds must be below 60.');
  const n=parts.reduce((a,n)=>a*60+n,0)*sign;
  return /^[+-]/.test(s)?current+n:n;
}
export function boundedPosition(position:number,duration:number|null):number {
  if(!duration||!Number.isFinite(duration))throw new Error('The source has not reported a duration. Seeking is unavailable.');
  if(!Number.isFinite(position)||position<0||position>=duration)throw new Error(`Choose a time from 0:00 to ${clock(Math.max(0,duration-1))}.`);
  return position;
}
export function clock(n:number):string {
  n=Math.max(0,Math.floor(n));return n>=3600?`${Math.floor(n/3600)}:${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`:`${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;
}
export class Gate {
  private busy=false;
  private waiters:Array<()=>void>=[];
  async idle(){if(this.busy)await new Promise<void>(resolve=>this.waiters.push(resolve))}
  /** Wait up to `ms` for the current action to finish. True when the gate is free. */
  async wait(ms:number):Promise<boolean>{
    if(!this.busy)return true;
    return await Promise.race([this.idle().then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),ms))]);
  }
  async run<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new Error('Still busy with the last request. Try again in a few seconds.');
    this.busy=true;try{return await fn()}finally{this.busy=false;for(const resolve of this.waiters.splice(0))resolve()}
  }
  get locked(){return this.busy}
}
