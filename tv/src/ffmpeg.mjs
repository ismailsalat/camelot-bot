import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
let capabilities;
export function hlsInputOptions(help) {
  // Hosts use /m3u8, /ts?url=... and .jpg for valid HLS/MPEG-TS bytes.
  // Restrict protocols and demuxers instead of trusting filename extensions.
  const args=['-protocol_whitelist','https,tls,tcp,crypto,httpproxy',
    '-format_whitelist','hls,mpegts,mov,aac,mp3,webvtt',
    '-allowed_extensions','ALL'];
  if (/\ballowed_segment_extensions\b/.test(help)) args.push('-allowed_segment_extensions','ALL');
  if (/\bextension_picky\b/.test(help)) args.push('-extension_picky','0');
  return args;
}
export async function ffmpegInputOptions(isHLS=false) {
  if (!isHLS) return [];
  capabilities??=run('ffmpeg',['-hide_banner','-h','demuxer=hls'],{timeout:5000,maxBuffer:100000})
    .then(({stdout,stderr})=>stdout+stderr)
    .catch(()=>{capabilities=null;throw new Error('FFmpeg HLS support could not be checked. Install FFmpeg first.');});
  return hlsInputOptions(await capabilities);
}
