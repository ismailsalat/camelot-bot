// Railway/.env values often arrive with stray quotes or spaces (for example 6000k' or "1280:720").
// FFmpeg then refuses to start the encoder, so every video fails. Clean and validate before use.
const PRESETS=new Set(['ultrafast','superfast','veryfast','faster','fast','medium']);
const strip=v=>String(v??'').trim().replace(/^[\s'"`]+|[\s'"`]+$/g,'').trim();
const RULES={
  STREAM_VIDEO_BITRATE:{ok:v=>/^\d{3,5}[kKmM]$/.test(v)&&(/[mM]$/.test(v)?Number(v.slice(0,-1))<=50:Number(v.slice(0,-1))<=50000),want:'a number with k or m, for example 6000k'},
  STREAM_RESOLUTION:{ok:v=>/^\d{3,4}[:x]\d{3,4}$/.test(v),want:'width:height, for example 1280:720',norm:v=>v.replace('x',':')},
  STREAM_FPS:{ok:v=>/^\d{1,2}(\.\d+)?$/.test(v)&&Number(v)>=1&&Number(v)<=60,want:'a number from 1 to 60'},
  STREAM_X264_PRESET:{ok:v=>PRESETS.has(v.toLowerCase()),want:[...PRESETS].join(', '),norm:v=>v.toLowerCase()},
  STREAM_FFMPEG_THREADS:{ok:v=>/^\d{1,2}$/.test(v)&&Number(v)>=1&&Number(v)<=16,want:'a number from 1 to 16'},
  STREAM_QUALITY:{ok:v=>/^(720p|1080p|4k)$/i.test(v),want:'720p, 1080p or 4k',norm:v=>v.toLowerCase()},
};
/** Returns {env, fixes}. env is a copy where every STREAM_* knob is clean or removed; fixes explains each change. */
export function cleanStreamEnv(source){
  const env={...source},fixes=[];
  for(const [name,rule] of Object.entries(RULES)){
    if(env[name]===undefined)continue;
    const raw=String(env[name]);let v=strip(raw);
    if(v!==raw.trim()||v!==raw)if(rule.ok(v)){fixes.push(`${name}=${JSON.stringify(raw)} had stray quotes or spaces; using ${v}`)}
    if(!rule.ok(v)){fixes.push(`${name}=${JSON.stringify(raw)} is not valid (want ${rule.want}); ignoring it and using the default`);delete env[name];continue}
    env[name]=rule.norm?rule.norm(v):v;
  }
  return {env,fixes};
}
