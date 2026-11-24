// Streaming timeline: one structured record per event, shared by correlation id (cid) across bot, TV service and worker.
// Every record carries a UTC wall-clock time (for ordering across processes) and a monotonic offset of THIS process
// (for durations, which must never be computed from wall-clock time). Durations are only ever computed between two
// records from the same process; cross-process figures are composed from per-process intervals.
// Bounded: ring buffer in memory plus an optional size-capped JSONL file (one rotation).
import {appendFileSync,statSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const SECRET_KEYS=/token|authorization|cookie|secret|password|apikey|api_key|signature|bearer|x-amz|sig=/i;
export function redactText(value){
  return String(value??'')
    .replace(/https?:\/\/[^\s<>"']+/g,'[url]')
    .replace(/(authorization|cookie|referer|origin|user-agent)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,'[token]')
    .replace(/([?&](?:token|sig|signature|key|expires|auth)=)[^&\s]+/gi,'$1[redacted]');
}
/** Redact an ffmpeg-style argument list: input URLs, header values and subtitle paths are dropped, flags are kept. */
export function redactArgs(args=[]){
  const out=[];
  for(let i=0;i<args.length;i++){
    const a=String(args[i]);
    if(['-i','-headers','-user_agent','-referer','-cookies','-http_proxy'].includes(a)){out.push(a,'[redacted]');i++;continue}
    out.push(redactText(a).replace(/subtitles=[^,:]+/g,'subtitles=[file]'));
  }
  return out;
}
export function redactDeep(value,depth=0){
  if(depth>6||value===null||value===undefined)return value??null;
  if(typeof value==='string')return redactText(value).slice(0,500);
  if(typeof value!=='object')return value;
  if(Array.isArray(value))return value.slice(0,50).map(v=>redactDeep(v,depth+1));
  const out={};
  for(const [k,v] of Object.entries(value)){
    if(SECRET_KEYS.test(k)){out[k]='[redacted]';continue}
    if(k==='headers'||k==='url'||k==='args'||k==='cmd'){out[k]='[redacted]';continue}
    out[k]=redactDeep(v,depth+1);
  }
  return out;
}

export class Timeline{
  constructor({origin='tv',capacity=800,file=null,maxFileBytes=1_500_000,wall=()=>Date.now(),mono=()=>Number(process.hrtime.bigint()/1000n)/1000}={}){
    Object.assign(this,{origin,capacity,file,maxFileBytes,wall,mono});
    this.ring=[];this.seq=0;this.bootMono=mono();this.writeFailed=false;
    if(file){try{mkdirSync(dirname(file),{recursive:true})}catch{this.file=null}}
  }
  record(event,fields={}){
    const entry={seq:++this.seq,utc:new Date(this.wall()).toISOString(),t_ms:Math.round((this.mono()-this.bootMono)*10)/10,origin:this.origin,event,...redactDeep(fields)};
    this.ring.push(entry);if(this.ring.length>this.capacity)this.ring.shift();
    if(this.file&&!this.writeFailed){
      try{
        try{if(statSync(this.file).size>this.maxFileBytes)renameSync(this.file,this.file+'.1')}catch{}
        appendFileSync(this.file,JSON.stringify(entry)+'\n');
      }catch{this.writeFailed=true}
    }
    return entry;
  }
  /** Records of one correlation id (or everything), oldest first. */
  forCid(cid){return cid?this.ring.filter(e=>e.cid===cid):this.ring.slice()}
  /** Milliseconds between the first `from` and the first later `to` record with the same cid and origin (same clock). */
  interval(cid,from,to,origin=this.origin){
    const rows=this.ring.filter(e=>e.cid===cid&&e.origin===origin);
    const a=rows.find(e=>e.event===from);if(!a)return null;
    const b=rows.find(e=>e.seq>a.seq&&e.event===to);
    return b?Math.round((b.t_ms-a.t_ms)*10)/10:null;
  }
  field(cid,event,name){const e=this.ring.find(r=>r.cid===cid&&r.event===event);const v=e?e[name]:null;return v===undefined?null:v}
  /** Short human-readable summary of one session: only intervals that were actually measured; unknown stays null. */
  summarize(cid){
    const iv=(a,b,o)=>this.interval(cid,a,b,o);
    return {cid,
      command_to_ack_ms:iv('play_request','play_ack'),
      resolution_ms:iv('resolve_start','resolve_done'),
      validation_ms:iv('validate_start','validate_done'),
      command_to_worker_ms:iv('play_request','worker_play_sent'),
      // Measured by the worker itself (its clock): from receiving the Play command to each milestone.
      worker_play_to_go_live_ready_ms:this.field(cid,'worker_go_live_ready','since_play_ms'),
      worker_play_to_first_video_sent_ms:this.field(cid,'worker_first_video_sent','since_play_ms'),
      worker_play_to_first_audio_sent_ms:this.field(cid,'worker_first_audio_sent','since_play_ms'),
      note:'Intervals are measured inside one process each; "sent" means handed to the network, not displayed by Discord clients.'};
  }
  export(extra={}){return {exportedAt:new Date(this.wall()).toISOString(),origin:this.origin,records:this.ring.slice(-this.capacity),...redactDeep(extra)}}
}
