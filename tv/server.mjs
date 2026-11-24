import {cleanStreamEnv} from './src/envclean.mjs';
import {WorkerCommands} from './src/commands.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getProviders,searchCatalog,listEpisodes,resolveEpisode} from './src/sdk.mjs';
import {rankedStreams,preflightVideo} from './src/source.mjs';
import {searchAnimeCatalog,sameAnime} from './src/catalog.mjs';
import {candidatePlan,tryPlayableEpisode} from './src/playback.mjs';
import {inspectSources,episodeMenu,matchingSources} from './src/availability.mjs';
import {prepareCaptions,discardCaptions,SUBTITLE_CHOICES} from './src/subtitles.mjs';
import {apiAccess,originAllowed} from './src/access.mjs';

const VERSION='0.12.0';
const DIR=resolve(fileURLToPath(new URL('.',import.meta.url)));
const INTERNAL=process.env.CAMELOT_INTERNAL==='1';
const CLOUD=!INTERNAL&&Boolean(process.env.RAILWAY_ENVIRONMENT||process.env.CAMELOT_BIND_ALL);
const HOST=CLOUD?'0.0.0.0':'127.0.0.1';
let PORT=Number(process.env.PORT||(CLOUD?'3000':'3333'));
const ADMIN_KEY=(process.env.CAMELOT_ADMIN_KEY||'').trim();
const BRIDGE_KEY=(process.env.CAMELOT_BRIDGE_KEY||'').trim();
if(BRIDGE_KEY&&BRIDGE_KEY.length<32)throw new Error('CAMELOT_BRIDGE_KEY must contain at least 32 characters');
if(BRIDGE_KEY&&BRIDGE_KEY===ADMIN_KEY)throw new Error('Use separate admin and TV bridge keys');
const captionFiles=new Set();
let activeCaptions=null;
async function discardPrepared(source){captionFiles.delete(source);await discardCaptions(source);}
function retireCaptions(source){if(source)setTimeout(()=>{if(source!==activeCaptions)discardPrepared(source).catch(()=>{});},60000).unref();}
if(CLOUD && ADMIN_KEY.length<20){console.error('CAMELOT_ADMIN_KEY must be at least 20 characters for a cloud deployment. Refusing to expose controls.');process.exit(2)}
if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw new Error('Invalid PORT');
const logs=[];
let lastError='';
const scrub=text=>{
  let msg=String(text||'').replace(/https?:\/\/[^\s<>"']+/g,'[media URL redacted]');
  for(const v of [process.env.CAMELOT_STREAMER_TOKEN,ADMIN_KEY,BRIDGE_KEY,worker?.token])if(v&&v.length>5) msg=msg.split(v).join('[redacted]');
  return msg;
};
const log=(kind,text)=>{
  const msg=scrub(text).slice(0,350);
  logs.push({time:new Date().toLocaleTimeString('en-US',{hour12:false}),kind,msg});
  if(logs.length>90)logs.shift();
  if(kind==='error') lastError=msg;
  console.log(`[${kind}] ${msg}`);
};
// Last worker output, printed if the worker dies from a signal so the cause is visible in the logs.
const workerTail=[];
let safeMode=false;
let streamConfig=null,envFixes=[];
function memoryReport(){
  const rd=p=>{try{return readFileSync(p,'utf8').trim()}catch{return null}};
  const max=rd('/sys/fs/cgroup/memory.max')||rd('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const kills=(rd('/sys/fs/cgroup/memory.events')||'').match(/oom_kill\s+(\d+)/)?.[1];
  const limit=max&&/^\d+$/.test(max)&&Number(max)<2**50?Math.round(Number(max)/1048576)+' MB':'not readable';
  return `Container memory limit: ${limit}; OOM kills so far: ${kills??'unknown'}`;
}
const worker={child:null,token:null,guild:null,ready:false,channels:[],account:null,voice:null,status:'offline',playing:null};
function control(job){
  if(!worker.child||worker.child.killed||!worker.child.stdin.writable)throw new Error('Streamer is not connected');
  worker.child.stdin.write(JSON.stringify(job)+'\n');
}
const commands=new WorkerCommands(control);
function workerStart(token,guild){
  if(worker.child) throw new Error('Streamer is already running');
  if(typeof token!=='string'||token.length<30||token.length>250||!/^[0-9]{15,22}$/.test(String(guild)))throw new Error('Missing or invalid streaming account token / server ID');
  const python=process.env.PYTHON_BIN || ((CLOUD||INTERNAL)?join(DIR,'.cloud-venv','bin','python'):'/home/'+(process.env.USER||'')+'/.local/share/camelot-tv/venv/bin/python');
  const {env:cleanEnv,fixes:foundFixes}=cleanStreamEnv(process.env);
  envFixes=foundFixes;for(const fix of foundFixes)log('warning','Setting fixed: '+fix);
  const childEnv={...cleanEnv, PYTHONUNBUFFERED:'1',STREAM_QUALITY:cleanEnv.STREAM_QUALITY||'720p',
    // Measured on Railway: 720p30 held 30.0 fps with no late frames, so the CPU has room. The old 2500k
    // bitrate with the fastest x264 preset is what made it look soft. Raise for a sharper picture:
    //   STREAM_RESOLUTION=1920:1080  STREAM_VIDEO_BITRATE=8000k   (needs more CPU)
    //   STREAM_X264_PRESET=veryfast|faster                         (better quality per bit, more CPU)
    STREAM_RESOLUTION:cleanEnv.STREAM_RESOLUTION||'1280:720',STREAM_FPS:cleanEnv.STREAM_FPS||'30',STREAM_VIDEO_BITRATE:cleanEnv.STREAM_VIDEO_BITRATE||'6000k',STREAM_X264_PRESET:cleanEnv.STREAM_X264_PRESET||'superfast'};
  if(safeMode)Object.assign(childEnv,{STREAM_RESOLUTION:'1280:720',STREAM_FPS:'30',STREAM_VIDEO_BITRATE:'4500k',STREAM_X264_PRESET:'superfast',STREAM_FFMPEG_THREADS:'3'});
  streamConfig={resolution:childEnv.STREAM_RESOLUTION,fps:childEnv.STREAM_FPS,bitrate:childEnv.STREAM_VIDEO_BITRATE,preset:childEnv.STREAM_X264_PRESET,threads:childEnv.STREAM_FFMPEG_THREADS||'4',safeMode};
  log('info',`Stream settings: ${childEnv.STREAM_RESOLUTION} at ${childEnv.STREAM_FPS} fps, ${childEnv.STREAM_VIDEO_BITRATE}, x264 ${childEnv.STREAM_X264_PRESET}, ${childEnv.STREAM_FFMPEG_THREADS||'4'} threads${safeMode?' (safe mode)':''}`);
  delete childEnv.CAMELOT_STREAMER_TOKEN;delete childEnv.CAMELOT_ADMIN_KEY;delete childEnv.CAMELOT_BRIDGE_KEY;
  const child=spawn(python,['-u',join(DIR,'runtime','camelot_worker.py')],{
    cwd:join(DIR,'runtime'),
    stdio:['pipe','pipe','pipe'],env:childEnv
  });
  lastError='';  worker.child=child;worker.token=token;worker.guild=String(guild);worker.ready=false;worker.status='connecting';worker.channels=[];worker.account=null;
  child.stdin.on('error',()=>{});
  child.stdin.write(JSON.stringify({token,guild:String(guild)})+'\n');
  child.on('error',e=>{commands.close();log('error','Python worker failed to start. Run setup or check Railway build logs.');if(worker.child===child){worker.child=null;worker.ready=false;worker.status='offline'}});
  child.on('close',(code,signal)=>{
    const abnormal=Boolean(signal)||(code!==null&&code!==0);
    const wasReady=worker.ready;
    log('info',`Streamer stopped (exit code ${code??'none'}${signal?`, signal ${signal}`:''})`);
    if(worker.child!==child)return;
    if(abnormal){
      for(const line of workerTail.slice(-12))log('error','worker: '+line);
      log('error',memoryReport());
      if(wasReady&&!safeMode){safeMode=true;log('warning','Safe mode on: the streamer crashed, so it will reconnect at 720p30 with fewer encoder threads.')}
    }
    commands.close();
    worker.child=null;worker.ready=false;worker.status='offline';worker.playing=null;worker.channels=[];
    const old=activeCaptions;activeCaptions=null;retireCaptions(old);
  });
  for(const [stream,kind] of [[child.stdout,'info'],[child.stderr,'worker']]){
    let buffer='';
    stream.on('data',b=>{
      buffer+=b.toString('utf8');
      if(buffer.length>100000)buffer=buffer.slice(-10000);
      let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trimEnd();buffer=buffer.slice(i+1);if(worker.child===child)consumeWorkerLine(line,kind)}
    });
  }
  log('info','Connecting streaming account to the selected test server');
}
/** Most recent FFmpeg complaint from the worker, so a failure says why instead of just 'interrupted'. */
function lastFfmpegProblem(){
  for(let i=workerTail.length-1;i>=0;i--){const l=workerTail[i];if(/ffmpeg video:|ffmpeg audio:|Unknown encoder|Error while opening|Invalid|No such file|Connection refused|Server returned|produced no output/i.test(l))return l.replace(/^.*?(WARNING|ERROR)\s+/,'').slice(0,220)}
  return '';
}
function consumeWorkerLine(line,kind){
  workerTail.push(scrub(line).slice(0,300));if(workerTail.length>30)workerTail.shift();
  if(line.startsWith('TV_BRIDGE_JSON:')){
    try{
      const e=JSON.parse(line.slice('TV_BRIDGE_JSON:'.length));
      if(commands.accept(e))return;
      if(e.event==='ready'){worker.ready=true;worker.streamerId=e.streamerId;worker.channels=e.channels||[];worker.account=e.streamer||'';if(['offline','connecting','failed'].includes(worker.status))worker.status='connected';log('info',`Connected as ${worker.account} to ${e.server} (${worker.channels.length} channels)`)}
      else if(['status','playing','paused','standby','ended','failed'].includes(e.event)){worker.failReason=e.event==='failed'?String(e.reason||''):'';worker.status=e.status||(e.event==='playing'?'streaming':e.event);worker.position=e.position??worker.position;worker.updated=Date.now();if(e.event==='failed'){if(e.reason==='kicked')log('warning','Removed from the voice channel; the bot will rejoin');else{const hint=lastFfmpegProblem();log('error',`Playback interrupted${e.reason?` (${e.reason})`:''}${hint?`. Last FFmpeg message: ${hint}`:''}`);for(const line of workerTail.slice(-6))log('warning','worker: '+line)}}}
      else if(e.event==='starting'){worker.status='starting';worker.position=e.position??0;worker.playing=e.title;worker.voice=e.channel;log('info','Go Live connection starting')}
      else if(e.event==='stream_requested'){worker.status='requested';log('info','Go Live session requested. Check the voice channel.')}
      else if(e.event==='stopped'){worker.status='connected';worker.playing=null;worker.position=0;worker.duration=null;log('info','Stopped playback')}
      else if(e.event==='error'){worker.status='failed';log('error',e.message||'Streaming error')}
      return;
    }catch{log('error','Malformed worker event');return}
  }
  // Playback state comes from structured events, never log matching.
  // Structured lifecycle events own end-of-stream status.
  if(/go-live connection failed|timed out waiting for audio|ffmpeg.*HTTP error/.test(line)){log('error','Streamer encountered a video/Go Live error; see activity log')}
  if(/(token|credentials delivered|user agent|TLS fingerprint|session id)/i.test(line)&&!/(error|warning)/i.test(line))return;
  if(/(ERROR|WARNING|Connected to test server|go-live stream finished|video stats|GoLive connection ready|starting go-live)/i.test(line))log(kind,line);
}
async function probeDuration(source){
 const {ffmpegInputOptions}=await import('./src/ffmpeg.mjs');
 const {ffmpegHeaderArgs}=await import('./src/source.mjs');
 const args=['-v','error','-rw_timeout','12000000',...await ffmpegInputOptions(source.isHLS),...ffmpegHeaderArgs(source.headers),'-i',source.url,'-show_entries','format=duration','-of','json'];
 return new Promise(resolve=>execFile('ffprobe',args,{timeout:15000,maxBuffer:100000},(error,stdout)=>{
   if(error)return resolve(null);
   try{const value=Number(JSON.parse(stdout).format?.duration);resolve(Number.isFinite(value)&&value>0?value:null)}catch{resolve(null)}
 }));
}
const cache=new Map();
function cachedSet(k,v){cache.set(k,{until:Date.now()+20*60*1000,value:v});if(cache.size>400)cache.delete(cache.keys().next().value)}
function cachedGet(k){const r=cache.get(k);if(!r||r.until<Date.now()){cache.delete(k);return null}return r.value}
const episodeRequests=new Map();
async function cachedEpisodes(provider,media){
 const key=`source-episodes:${provider}:${media}`;
 const existing=cachedGet(key);if(existing)return existing;
 if(episodeRequests.has(key))return episodeRequests.get(key);
 const pending=listEpisodes(provider,media).then(rows=>{cachedSet(key,rows);return rows;}).finally(()=>episodeRequests.delete(key));
 episodeRequests.set(key,pending);return pending;
}
function knownMedia(){return [...cache.entries()].filter(([k,v])=>k.startsWith('media:')&&v.until>Date.now()).map(([,v])=>v.value);}
async function discoverMatches(selection){
 const key=`matches:${selection.provider}:${selection.id}`;
 const stored=cachedGet(key);if(stored)return stored;
 // The search the user just ran already cached every provider's hits. Reuse them instead of
 // asking all eleven sources again, which cost another ~12 seconds before episodes loaded.
 const already=matchingSources(selection,knownMedia());
 if(already.length>=2){const reused={candidates:already,failures:[]};cachedSet(key,reused);return reused}
 // Otherwise search all enabled providers even when the user selected one source in search.
 const sources=await searchCatalog(selection.title,'all');
 for(const item of sources.results)cachedSet(`media:${item.provider}:${item.id}`,item);
 let candidates=matchingSources(selection,knownMedia());
 const names=(selection.aliases||[]).filter(n=>n!==selection.title);
 if(candidates.length<2&&names.length){
   const extra=await searchCatalog(names[0],'all');
   for(const item of extra.results)cachedSet(`media:${item.provider}:${item.id}`,item);
   candidates=matchingSources(selection,knownMedia());
 }
 const result={candidates,failures:sources.failures};cachedSet(key,result);return result;
}
async function loadTitle(selection){
 const found=await discoverMatches(selection);
 const rows=await inspectSources(selection,found.candidates,cachedEpisodes,{graceMs:Number(process.env.EPISODE_GRACE_MS)||3000});
 const episodes=episodeMenu(rows,{incomplete:found.failures.length>0});
 const selected=selection.provider==='catalog'?found.candidates[0]:selection;
 if(!selected||!episodes.length)throw new Error('No matching source returned episodes. Try Refresh Sources or another title.');
 const selectedWithAliases={...selected,aliases:[selection.title,...(selection.aliases||[])]};
 cachedSet(`media:${selected.provider}:${selected.id}`,selectedWithAliases);
 cachedSet(`episodes:${selected.provider}:${selected.id}`,episodes);
 const availability={sources:rows.map(r=>({provider:r.provider,status:r.status,episodeCount:r.episodes.length})),failures:found.failures};
 cachedSet(`availability:${selected.provider}:${selected.id}`,availability);
 return {episodes,selection:selectedWithAliases,...availability};
}
let playBusy=false;
let playGeneration=0; // Stop requests can abort an in-progress episode verification.
const json=(res,status,data)=>{const s=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(s),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(s)};
async function body(req){
 return new Promise((resolve,reject)=>{
   let s='';req.on('data',b=>{s+=b.toString('utf8');if(s.length>8000){req.destroy();reject(new Error('Request too large'))}});
   req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(new Error('Invalid JSON request'))}});req.on('error',reject);
 });
}
function state(){return {version:VERSION,cloud:CLOUD,status:worker.status,connected:worker.ready,account:worker.account,
 guild:worker.ready?worker.guild:null,channels:worker.channels,playing:worker.playing,
 position:worker.position||0,duration:worker.duration||null,updated:worker.updated||0,streamerId:worker.streamerId,safeMode,config:streamConfig,envFixes,failReason:worker.failReason||'',providers:[],logs:logs.slice(-55),busy:playBusy,lastError};}
function err(res,e,code=400){const m=String(e?.message||e||'Unknown error').replace(/https?:\/\/[^\s<>"']+/g,'[media URL]');log('error',m);json(res,code,{error:m.slice(0,1800)})}
const STATIC={'/':'index.html','/ui.js':'ui.js','/ui.css':'ui.css'};
const TYPES={'index.html':'text/html; charset=utf-8','ui.js':'application/javascript; charset=utf-8','ui.css':'text/css; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
 try{
   const host=req.headers.host||'';
   if(!CLOUD && host!==`localhost:${PORT}` && host!==`127.0.0.1:${PORT}`){return json(res,403,{error:'Localhost only'})}
   let url=new URL(req.url||'/',`http://${host||'localhost'}`),path=url.pathname;
   if(req.method==='GET'&&STATIC[path]){
     const f=STATIC[path];const data=await readFile(join(DIR,'public',f));
     res.writeHead(200,{'Content-Type':TYPES[f],'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'});
     return res.end(data);
   }
   if(path==='/health')return json(res,200,{ok:true,service:'Camelot TV',version:VERSION,port:PORT});
   if(!path.startsWith('/api/'))return json(res,404,{error:'Not found'});
   const role=apiAccess(req,path,{cloud:CLOUD||INTERNAL,adminKey:ADMIN_KEY,bridgeKey:BRIDGE_KEY});
   if(!role)return json(res,401,{error:'Enter the admin key or a valid TV bridge key'});
   if(!originAllowed(req,{cloud:CLOUD,role}))return json(res,403,{error:'Cross-site request rejected'});
   if(path==='/api/state'&&req.method==='GET'){const snapshot=state();if(role==='bridge'){delete snapshot.logs;delete snapshot.account;delete snapshot.lastError;}return json(res,200,snapshot);}
   if(path==='/api/providers'&&req.method==='GET')return json(res,200,{providers:[...(await getProviders()).keys()]});
   if(path==='/api/search'&&req.method==='GET'){
     const q=(url.searchParams.get('q')||'').trim().slice(0,80);
     const provider=url.searchParams.get('provider')||'all';
     if(q.length<2)throw new Error('Type at least 2 characters');
     // Content providers are independent from the metadata catalog. A metadata hit is NOT playable.
     // Search both concurrently, but keep clear status markers in the response.
     const [sources,meta]=await Promise.all([
       provider==='catalog'?Promise.resolve({results:[],failures:[]}):searchCatalog(q,provider).catch(e=>({results:[],failures:[{provider:'anime-sdk',reason:'provider engine unavailable'}]})),
       provider==='all'||provider==='catalog'?searchAnimeCatalog(q):Promise.resolve({results:[],source:null,errors:[]})
     ]);
     const results=[...sources.results.map(r=>({...r,poster:r.poster||meta.results.find(m=>sameAnime(m,r))?.poster||'',availability:'source-candidate'})),...meta.results];
     for(const r of results)cachedSet(`media:${r.provider}:${r.id}`,r);
     log('info',`Anime search: ${sources.results.length} online source candidates, ${meta.results.length} catalog titles (${sources.failures.length} provider errors)`);
     if(!results.length){
       const detail=[...sources.failures.map(f=>`${f.provider}: ${f.reason}`),...meta.errors].join('; ');
       log('warning',`Search returned nothing. ${detail||'No matching titles from configured providers'}`);
     }
     return json(res,200,{results,failures:sources.failures,catalogErrors:meta.errors,
       sourceCount:sources.results.length,catalogCount:meta.results.length,catalogSource:meta.source});
   }
   if(path==='/api/episodes'&&req.method==='GET'){
     const p=url.searchParams.get('provider')||'',id=url.searchParams.get('id')||'';
     const selection=cachedGet(`media:${p}:${id}`);
     if(!selection)throw new Error('Search for this anime first');
     if(url.searchParams.get('refresh')==='1'){
       for(const key of [...cache.keys()])if(/^(matches:|source-episodes:|availability:)/.test(key))cache.delete(key);
     }
     const loaded=await loadTitle(selection);
     log('info',`Checked ${loaded.sources.length} matching source listings; ${loaded.episodes.length} episodes with Sub/Dub availability`);
     return json(res,200,loaded);
   }
   if(path==='/api/connect'&&req.method==='POST'){
     const b=await body(req);
     const token=(CLOUD?process.env.CAMELOT_STREAMER_TOKEN:b.token)||worker.token;
     const guild=(CLOUD?process.env.CAMELOT_GUILD_ID:b.guild)||worker.guild;
     workerStart(token,guild);return json(res,202,{ok:true,message:'Connecting to Discord'});
   }
   if(['/api/play','/api/check'].includes(path)&&req.method==='POST'){
     const checkOnly=path==='/api/check';
     if(playBusy)return json(res,409,{error:'Already checking an episode. Do not double-click Play.'});
     playBusy=true;
     try{
       const b=await body(req);
       const generation=++playGeneration;
       const deadline=Date.now()+180000;
       const provider=String(b.provider||''),media=String(b.media||''),unit=String(b.unit||'');
       const episodes=cachedGet(`episodes:${provider}:${media}`)||[];
       const chosen=episodes.find(e=>e.id===unit);
       if(!chosen||!cachedGet(`media:${provider}:${media}`))throw new Error('Choose an anime and episode from search results first');
       if(!checkOnly&&!worker.ready)throw new Error('Connect the streamer before playing');
       const channel=String(b.channel||'');
       if(!checkOnly&&!worker.channels.some(c=>c.id===channel))throw new Error('Select a valid voice channel');
       const lang=['sub','dub','raw'].includes(b.lang)?b.lang:'sub';
       const captions=String(b.subtitles||'en');
       if(!SUBTITLE_CHOICES.includes(captions))throw new Error('Choose a supported subtitle language');
       if(role==='bridge'&&String(b.guild||'')!==String(worker.guild||process.env.CAMELOT_GUILD_ID||''))throw new Error('This TV worker is paired with a different server');
       const original=cachedGet(`media:${provider}:${media}`);
       const found=await discoverMatches(original);
       let queue=candidatePlan({provider,media,alt:true},original,found.candidates,lang);
       if(b.source&&b.source!=='auto'){if(!queue.some(q=>q.provider===b.source))throw new Error('Selected source does not match this title');queue.sort((a,z)=>Number(z.provider===b.source)-Number(a.provider===b.source));}
       if(!queue.length)throw new Error('Selected source does not match this title');
       if(!checkOnly)await commands.request({op:'standby',channel});
       log('info',`Testing ${queue.length} matching provider(s) for episode ${chosen.number}: ${queue.map(q=>q.provider).join(', ')}`);
       const result=await tryPlayableEpisode({
         queue,episode:chosen,language:lang,
         list:cachedEpisodes,resolve:resolveEpisode,rank:rankedStreams,
         prepare:async source=>{const prepared=await prepareCaptions(source,captions,{shouldStop:()=>generation!==playGeneration||Date.now()>deadline});if(prepared.subtitleDir)captionFiles.add(prepared);return prepared;},
         discard:discardPrepared,
         probe:(mediaUrl,headers,isHLS,source)=>preflightVideo(mediaUrl,headers,35000,{isHLS,subtitlePath:source.subtitlePath,shouldStop:()=>generation!==playGeneration||Date.now()>deadline}),
         shouldStop:()=>generation!==playGeneration||Date.now()>deadline,
         onProgress:msg=>log(/unavailable|failed|no video|HTTP|missing|timed out|Ambiguous/i.test(msg)?'warning':'info',msg),
         onSuccess:async(source,entry)=>{
           if(checkOnly){await discardPrepared(source);return;}
           const duration=await probeDuration(source);
           if(generation!==playGeneration||Date.now()>deadline)throw new Error('Playback cancelled');
           worker.duration=duration;worker.position=Number(b.position)||0;worker.failReason='';worker.status='starting';
           await commands.request({op:'play',duration,position:Math.min(Number(b.position)||0,Math.max(0,(duration||864000)-1)),channel,url:source.url,headers:source.headers,isHLS:source.isHLS,subtitlePath:source.subtitlePath,
             title:`${String(original.title||'Camelot TV').slice(0,55)} · E${chosen.number} ${lang.toUpperCase()}`});
           const old=activeCaptions;activeCaptions=source;retireCaptions(old);
         }
       });
       log('info',`Verified a real video frame from ${result.provider}${checkOnly?'':' ; requested Go Live'}`);
       return json(res,checkOnly?200:202,{ok:true,quality:result.quality,provider:result.provider,
         language:lang,subtitle:result.subtitle,failures:result.failures,message:checkOnly?'Episode video verified. Press Play to stream it.':'Verified real video frame; starting Go Live.'});
     }finally{playBusy=false}
   }
   if(path==='/api/test-online'&&req.method==='POST'){
     if(playBusy)return json(res,409,{error:'A video check is already running. Try again after it finishes.'});
     playBusy=true;
     const generation=++playGeneration;
       const deadline=Date.now()+180000;
     try{
       const b=await body(req);
       if(!worker.ready)throw new Error('Connect the streamer before testing online playback');
       const channel=String(b.channel||'');
       if(!worker.channels.some(c=>c.id===channel))throw new Error('Select a voice channel first');
       // Independent publicly available animation samples, not a claim of anime availability.
       const samples=[
         ['W3C Sintel trailer','https://media.w3.org/2010/05/sintel/trailer.mp4'],
         ['Google Big Buck Bunny','https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4']
       ];
       const failures=[];
       for(const [name,url] of samples){
         if(generation!==playGeneration||Date.now()>deadline)throw new Error('Video check cancelled');
         log('info',`Testing remote video: ${name}...`);
         try {
           await preflightVideo(url,{},18000,{shouldStop:()=>generation!==playGeneration||Date.now()>deadline});
           if(generation!==playGeneration||Date.now()>deadline)throw new Error('Video check cancelled');
           control({op:'play',channel,url,headers:{},isHLS:false,title:'Camelot TV Online Video Test'});
           log('info',`${name}: video frame decoded. Opening Go Live.`);
           return json(res,202,{ok:true,message:`${name} video verified. Opening Go Live.`});
         }catch(e){
           if(/cancelled/i.test(String(e?.message)))throw e;
           failures.push(`${name}: ${e.message}`);
           log('warning',`${name}: ${e.message}`);
         }
       }
       throw new Error('Public online video test failed: '+failures.join(' | '));
     }finally{playBusy=false}
   }
   if(['/api/pause','/api/resume','/api/seek','/api/standby'].includes(path)&&req.method==='POST'){
     const b=await body(req);
     if(path==='/api/seek'&&(!Number.isFinite(b.position)||!worker.duration||b.position<0||b.position>=worker.duration))throw new Error('Choose a time inside the episode');
     await commands.request({op:path.split('/').pop(),position:b.position,channel:b.channel});
     return json(res,202,{ok:true});
   }
   if(path==='/api/stop'&&req.method==='POST'){
     if(role==='bridge'){const b=await body(req);if(String(b.guild||'')!==String(worker.guild||process.env.CAMELOT_GUILD_ID||''))throw new Error('This TV worker is paired with a different server');}
     playGeneration++;const old=activeCaptions;activeCaptions=null;retireCaptions(old);
     if(worker.child)await commands.request({op:'stop'});return json(res,202,{ok:true});
   }
   if(path==='/api/disconnect'&&req.method==='POST'){
     playGeneration++;
     if(worker.child)await commands.request({op:'quit'});return json(res,202,{ok:true});
   }
   return json(res,404,{error:'Unknown endpoint'});
 }catch(e){return err(res,e, /provider|connect|failed|FFmpeg/i.test(e?.message||'')?502:400)}
});
const START_PORT=PORT;
server.on('error',error=>{
 if(!INTERNAL&&!CLOUD && error.code==='EADDRINUSE' && PORT < START_PORT+20){
   const inUse=PORT++;
   console.error(`[Camelot TV] Port ${inUse} already used by an older Camelot TV. Trying ${PORT} instead.`);
   return setTimeout(()=>server.listen(PORT,HOST),50);
 }
 console.error(`[Camelot TV] Cannot open server: ${error.message}. ${CLOUD?'Check Railway PORT':'Close old servers or use another port'}.`);
 process.exitCode=1;
});
server.listen(PORT,HOST,()=>{
 console.log(`[Camelot TV] OPEN THIS URL: http://localhost:${PORT}`);
 console.log(`Camelot TV online playback v${VERSION} on http://${HOST}:${PORT}`);
 log('info',`Camelot TV v${VERSION}: Dub fallback and subtitle rendering loaded; no episode uploads needed`);
 if(!INTERNAL&&CLOUD&&process.env.CAMELOT_STREAMER_TOKEN&&process.env.CAMELOT_GUILD_ID){
   try{workerStart(process.env.CAMELOT_STREAMER_TOKEN,process.env.CAMELOT_GUILD_ID)}catch(e){log('error','Cloud worker cannot start; check configuration')}
 }
});
let shuttingDown=false;
async function shutdown(){
 if(shuttingDown)return;shuttingDown=true;playGeneration++;
 server.close();server.closeAllConnections();
 const child=worker.child;
 if(child){
   const exited=new Promise(resolve=>child.once('close',resolve));
   try{control({op:'quit'})}catch{}
   const timer=setTimeout(()=>{child.kill('SIGKILL')},10000);
   await exited;clearTimeout(timer);
 }
 commands.close();await Promise.allSettled([...captionFiles].map(discardPrepared));process.exit(0);
}
process.on('SIGTERM',()=>void shutdown());
process.on('SIGINT',()=>void shutdown());
