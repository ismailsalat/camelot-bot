export interface Title {id:string;provider:string;title:string;poster?:string;aliases?:string[]}
export interface Episode {id:string;number:number;title:string;languages?:string[]}
export type Phase='idle'|'loading'|'playing'|'paused'|'offline'|'error';
export interface Session {
  id:string;guild:string;channel:string;message?:string;owner:string|null;
  title?:Title;episodes:Episode[];episode:number;sources:string[];source:string;actualSource?:string;
  lang:'sub'|'dub';phase:Phase;position:number;duration:number|null;changed:number;note:string;
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
  async run<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new Error('One moment, the last change is still finishing.');
    this.busy=true;try{return await fn()}finally{this.busy=false}
  }
  get locked(){return this.busy}
}
