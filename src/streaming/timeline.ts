/** Bot-side streaming timeline. Same idea as tv/src/timeline.mjs: UTC time for ordering across processes, a monotonic
 *  offset for durations inside this process, a shared correlation id (cid), bounded memory, no secrets. */
const URL_RE=/https?:\/\/[^\s<>"']+/g;
export interface Mark{seq:number;utc:string;t_ms:number;origin:'bot';event:string;cid?:string;[k:string]:unknown}
export class BotTimeline{
  private ring:Mark[]=[];private seq=0;private boot=performance.now();
  constructor(private capacity=400){}
  mark(event:string,fields:Record<string,unknown>={}):Mark{
    const clean:Record<string,unknown>={};
    for(const [k,v] of Object.entries(fields)){
      if(/token|authorization|secret|password|headers|url/i.test(k)){clean[k]='[redacted]';continue}
      clean[k]=typeof v==='string'?v.replace(URL_RE,'[url]').slice(0,300):v;
    }
    const entry={seq:++this.seq,utc:new Date().toISOString(),t_ms:Math.round((performance.now()-this.boot)*10)/10,origin:'bot' as const,event,...clean} as Mark;
    this.ring.push(entry);if(this.ring.length>this.capacity)this.ring.shift();
    return entry;
  }
  forCid(cid:string){return this.ring.filter(m=>m.cid===cid)}
  all(){return this.ring.slice()}
  /** Milliseconds between the first `from` and the first later `to` mark of one session (same process clock), or null. */
  interval(cid:string,from:string,to:string):number|null{
    const rows=this.forCid(cid),a=rows.find(r=>r.event===from);if(!a)return null;
    const b=rows.find(r=>r.seq>a.seq&&r.event===to);return b?Math.round((b.t_ms-a.t_ms)*10)/10:null;
  }
  summary(cid:string){
    return {cid,
      interaction_to_ack_ms:this.interval(cid,'interaction_received','interaction_acked'),
      command_to_play_ack_ms:this.interval(cid,'play_requested','play_acked'),
      command_to_loading_panel_ms:this.interval(cid,'play_requested','panel_loading_painted'),
      play_ack_to_playing_panel_ms:this.interval(cid,'play_acked','phase_playing'),
      note:'Bot-process intervals only; they do not include Discord client display time.'};
  }
}
export const botTimeline=new BotTimeline();
