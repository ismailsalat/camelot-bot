import {spawn} from 'node:child_process';
import {lookup} from 'node:dns/promises';
import net from 'node:net';
import {ffmpegInputOptions} from './ffmpeg.mjs';

const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|internal|lan|test|invalid|onion)$/i;
export function validateMediaUrl(input) {
  if (typeof input !== 'string' || input.length > 3000 || /[\x00-\x1f\x7f]/.test(input)) return null;
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443')) return null;
    const host=u.hostname.replace(/\.$/,'').toLowerCase();
    if (PRIVATE_SUFFIX.test(host) || net.isIP(host) || host.length > 253 || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return null;
    return u.toString();
  } catch { return null; }
}
export function isPublicIP(ip) {
  if (!net.isIP(ip)) return false;
  if (net.isIP(ip) === 4) {
    let a = ip.split('.').map(Number); let [x,y] = a;
    return !(x===0 || x===10 || x===127 || x>=224 || x===169&&y===254 || x===172&&y>=16&&y<=31 || x===192&&y===168 || x===192&&y===0 || x===198&&y===18 || x===198&&y===19 || x===100&&y>=64&&y<=127 || x===192&&y===0 || x===192&&y===88 || x===192&&y===0 || x===198&&y===51 || x===203&&y===0);
  }
  const s=ip.toLowerCase();
  return !(s==='::1'||s==='::'||s.startsWith('fe80:')||s.startsWith('fc')||s.startsWith('fd')||s.startsWith('::ffff:')||s.startsWith('2001:db8:'));
}
export async function assertPublicHost(url) {
  const u = new URL(url);
  const addrs = await lookup(u.hostname,{all:true});
  if (!addrs.length || addrs.some(x=>!isPublicIP(x.address))) throw new Error('Video host is not a public Internet address');
}
const ALLOWED_HEADER_KEYS = new Map([['referer','Referer'],['user-agent','User-Agent'],['origin','Origin']]);
export function cleanHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  let result={};
  for (const [name,value] of Object.entries(raw)) {
    const key=ALLOWED_HEADER_KEYS.get(name.toLowerCase());
    if (key && typeof value==='string' && value.length<600 && !/[\r\n\x00-\x1f]/.test(value)) result[key]=value;
  }
  return result;
}
export function rankedStreams(raw,lang='sub') {
  // Output at 1080p wants a 1080p source; otherwise 720p is plenty and cheaper to decode.
  const wantsFullHd=Number(String(process.env.STREAM_RESOLUTION||'').split(/[:x]/)[1])>=1000;
  const prefs=wantsFullHd?{'1080p':0,'auto':1,'720p':2,'480p':3,'360p':4}:{'720p':0,'auto':1,'480p':2,'1080p':3,'360p':4};
  if (!Array.isArray(raw)) return [];
  return raw.filter(s=>validateMediaUrl(s?.sourceUrl)&&(!s.language||s.language===lang)).map(s=>({
    url: validateMediaUrl(s.sourceUrl), isHLS:Boolean(s.isHLS), quality:s.quality||'auto',
    language:s.language||lang, headers:cleanHeaders(s.headers),
    subtitles:Array.isArray(s.subtitles)?s.subtitles.filter(t=>validateMediaUrl(t?.url)).map(t=>({url:validateMediaUrl(t.url),language:t.language,label:t.label,format:t.format})).slice(0,30):[],
  })).sort((a,b)=>(prefs[a.quality]??5)-(prefs[b.quality]??5)).slice(0,8);
}
export function ffmpegHeaderArgs(headers) {
  const h=cleanHeaders(headers);
  if (!Object.keys(h).length) return [];
  return ['-headers', Object.entries(h).map(([k,v])=>`${k}: ${v}\r\n`).join('')];
}
export function describeVideoError(stderr='',code=null,timedOut=false){
  // Do not output CDN URLs, temporary credentials, referer headers or tokens.
  const s=String(stderr);
  const httpCode=s.match(/(?:HTTP error |Server returned |HTTP\/\d\.\d )([45]\d\d)/i)?.[1];
  if (httpCode==='429')return 'HTTP 429: video host is rate-limiting requests. Respect cooldown and use another authorized source.';
  if (httpCode==='403')return 'HTTP 403: video host refused media access (often permissions or expiring URL).';
  if (httpCode==='401')return 'HTTP 401: video source requires authorization; cannot play this source.';
  if (httpCode==='404')return 'HTTP 404: media URL has expired or been removed.';
  if (httpCode)return `HTTP ${httpCode}: video host rejected the media request.`;
  if (/No such filter.*(?:ass|subtitles)|Error initializing filter.*(?:ass|subtitles)/i.test(s))return 'FFmpeg subtitle rendering is unavailable. Install FFmpeg with libass support or choose Subtitles Off.';
  if (/allowed_segment_extensions|allowed_extensions|extension.*(?:blocked|mismatch|not in|not allowed)/i.test(s))return 'FFmpeg rejected the HLS segment filename. Restart with Camelot TV v0.9 so both the video check and player use the HLS fix.';
  if (/Invalid data found when processing input|invalid data/i.test(s))return 'Provider returned data FFmpeg cannot decode as video (possibly an HTML page or expired playlist).';
  if (/Server returned 3\d\d|redirect/i.test(s))return 'Video URL redirected or returned an unexpected response.';
  if (/Unable to open resource|Error when loading first segment|Failed to open segment|Error opening.*segment/i.test(s))return 'HLS playlist loads, but one or more video segments are unavailable.';
  if (/TLS|SSL|certificate|handshake/i.test(s))return 'Secure connection to the video CDN failed.';
  if (/No such host|Name or service not known|Temporary failure in name resolution/i.test(s))return 'Video source hostname cannot be resolved.';
  if (timedOut)return 'Video source did not deliver a playable frame before the timeout.';
  return code===0?'Video frame decoded':'FFmpeg could not decode a frame from this online source.';
}
import {existsSync} from 'node:fs';
const NICE=process.platform!=='win32'&&(existsSync('/usr/bin/nice')||existsSync('/bin/nice'));
export async function preflightVideo(url, headers={}, timeoutMs=35000, {shouldStop=()=>false,isHLS=false,subtitlePath=null}={}) {
    const valid=validateMediaUrl(url);
    if(!valid)throw new Error('Invalid or non-HTTPS video source');
    if(shouldStop())throw new Error('Video check cancelled');
    await assertPublicHost(valid);
    const inputOptions=await ffmpegInputOptions(isHLS);
    const subtitleArgs=subtitlePath?['-vf',(await import('./subtitles.mjs')).subtitleFilter(subtitlePath)]:[];
    if(shouldStop())throw new Error('Video check cancelled');
  return new Promise((resolve,reject)=>{
    // Decode a real video frame without storing the source content. No DRM bypass.
    // One decoder thread and low priority: this check runs while another episode may still be streaming, and a
    // second FFmpeg competing for the container's CPU quota is what made the live picture stutter during Next/switch.
    const args=['-nostdin','-hide_banner','-loglevel','error','-threads','1',
      '-rw_timeout','15000000',...inputOptions,...ffmpegHeaderArgs(headers),'-i',valid,
      '-map','0:v:0',...subtitleArgs,'-frames:v','1','-an','-progress','pipe:1','-f','null','-'];
    const niceAvailable=NICE;
    const child=niceAvailable?spawn('nice',['-n','10','ffmpeg',...args],{stdio:['ignore','pipe','pipe']}):spawn('ffmpeg',args,{stdio:['ignore','pipe','pipe']});
    let progress='',decodedFrame=false;
    child.stdout.on('data',b=>{progress=(progress+b.toString()).slice(-4000);if (/(?:^|\n)frame=\s*[1-9]\d*/.test(progress))decodedFrame=true;});
    let stderr='';let done=false;let timedOut=false;let cancelled=false;
    const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},timeoutMs);
    const cancelTimer=setInterval(()=>{if(shouldStop()){cancelled=true;child.kill('SIGKILL')}},120);
    const finish=()=>{clearTimeout(timeout);clearInterval(cancelTimer)};
    child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-3500)});
    child.on('error',()=>{if(!done){done=true;finish();reject(new Error('FFmpeg is missing or could not be started'))}});
    child.on('close',code=>{
      if(done)return;done=true;finish();
      if(cancelled)return reject(new Error('Video check cancelled'));
      if(code===0 && decodedFrame)return resolve({ok:true});
      if(code===0)return reject(new Error('Video source ended without decoding a frame'));
      reject(new Error(describeVideoError(stderr,code,timedOut)));
    });
  });
}
