// Provider health registry and failure classification. In memory only; it exists to stop us waiting through the
// same dead provider on every request and to explain *why* a provider failed.
export const FAILURE_CLASSES=['dns','timeout','http_error','rate_limit','parser','wrong_title','unavailable_episode','expired_url','manifest','segment','decode','missing_audio','cancelled','unknown'];

/** Turn any provider error into one of FAILURE_CLASSES (the text is only used for classification, never stored whole). */
export function classifyFailure(error){
  const text=String(error?.code?`${error.code} ${error.message}`:error?.message||error||'').toLowerCase();
  if(/cancel/.test(text))return 'cancelled';
  if(/enotfound|eai_again|getaddrinfo|dns|could not resolve host|name or service not known/.test(text))return 'dns';
  if(/429|rate.?limit|too many requests/.test(text))return 'rate_limit';
  if(/\b410\b|expired|signature|invalid token/.test(text))return 'expired_url';
  if(/\b403\b|forbidden|access denied/.test(text))return 'http_error';
  if(/timed out|timeout|etimedout|econnreset|aborted|socket hang up|deadline/.test(text))return 'timeout';
  if(/requested episode\/language unavailable|does not list|no matching episode|ambiguous episode|not available yet|not released/.test(text))return 'unavailable_episode';
  if(/season|wrong title|does not match|different title/.test(text))return 'wrong_title';
  if(/\bhttp (?:4|5)\d\d\b|status (?:4|5)\d\d|http error/.test(text))return 'http_error';
  if(/m3u8|manifest|playlist|mpd|invalid data found when processing input|moov atom/.test(text)&&!/segment/.test(text))return 'manifest';
  if(/segment|\.ts\b|\.m4s\b|chunk/.test(text))return 'segment';
  if(/no audio|missing audio|no audio stream/.test(text))return 'missing_audio';
  if(/decod|no video|no playable video|no frame|invalid frame|codec/.test(text))return 'decode';
  if(/json|parse|unexpected token|html|iframe|selector|no direct https video url|schema/.test(text))return 'parser';
  return 'unknown';
}
// Failures that say something about the provider itself (as opposed to this one title/episode).
const PROVIDER_LEVEL=new Set(['dns','timeout','http_error','rate_limit','parser','manifest','segment','decode']);

const MAX_RECENT=20;
export class ProviderHealth{
  constructor({now=()=>Date.now(),threshold=3,baseCooldownMs=120000,maxCooldownMs=900000}={}){
    Object.assign(this,{now,threshold,baseCooldownMs,maxCooldownMs});this.map=new Map();
  }
  entry(name){
    let e=this.map.get(name);
    if(!e){e={provider:name,recent:[],consecutive:0,cooldownUntil:0,cooldowns:0,lastSuccess:0,lastFailure:0,lastClass:null,successes:0,failures:0,latencyMs:null,languages:{},formats:{}};this.map.set(name,e)}
    return e;
  }
  success(name,{ms=0,language,format}={}){
    const e=this.entry(name),t=this.now();
    e.consecutive=0;e.cooldownUntil=0;e.cooldowns=0;e.lastSuccess=t;e.successes++;
    e.latencyMs=e.latencyMs===null?ms:Math.round(e.latencyMs*.7+ms*.3);
    if(language)e.languages[language]=t;if(format)e.formats[format]=t;
    e.recent.push({t,ok:true,ms});if(e.recent.length>MAX_RECENT)e.recent.shift();
  }
  failure(name,error,{ms=0}={}){
    const cls=typeof error==='string'&&FAILURE_CLASSES.includes(error)?error:classifyFailure(error),e=this.entry(name),t=this.now();
    e.lastFailure=t;e.lastClass=cls;e.failures++;
    e.recent.push({t,ok:false,ms,cls});if(e.recent.length>MAX_RECENT)e.recent.shift();
    if(PROVIDER_LEVEL.has(cls)){
      e.consecutive++;
      if(e.consecutive>=this.threshold){
        e.cooldowns++;
        e.cooldownUntil=t+Math.min(this.maxCooldownMs,this.baseCooldownMs*2**(e.cooldowns-1));
      }
    }
    return cls;
  }
  coolingDown(name){return this.entry(name).cooldownUntil>this.now()}
  /** Lower is better. Recent success and speed first, failures last. */
  score(name){
    const e=this.entry(name);
    if(this.coolingDown(name))return 1000;
    return e.consecutive*20+(e.latencyMs?Math.min(30,e.latencyMs/1000):5)-(e.lastSuccess&&this.now()-e.lastSuccess<600000?10:0);
  }
  /** Healthy providers first, keeping the configured preference as the tie-break; cooled-down ones go last. */
  order(items,key=x=>x.provider){
    return items.map((item,index)=>({item,index,score:this.score(key(item))})).sort((a,b)=>a.score-b.score||a.index-b.index).map(x=>x.item);
  }
  summary(){
    const t=this.now();
    return [...this.map.values()].map(e=>({provider:e.provider,successes:e.successes,failures:e.failures,consecutiveFailures:e.consecutive,
      lastSuccessAgoS:e.lastSuccess?Math.round((t-e.lastSuccess)/1000):null,lastFailureAgoS:e.lastFailure?Math.round((t-e.lastFailure)/1000):null,
      lastFailureClass:e.lastClass,cooldownLeftS:Math.max(0,Math.round((e.cooldownUntil-t)/1000)),latencyMs:e.latencyMs,
      languages:Object.keys(e.languages),formats:Object.keys(e.formats),recent:e.recent.slice(-5).map(r=>r.ok?'ok':r.cls)}));
  }
}
export const health=new ProviderHealth();
