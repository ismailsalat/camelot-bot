import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hlsInputOptions,ffmpegInputOptions} from '../src/ffmpeg.mjs';
import {describeVideoError} from '../src/source.mjs';
const run=promisify(execFile);

test('old FFmpeg gets no unsupported HLS options; input protocols exclude local files',()=>{
  const old=hlsInputOptions('allowed_extensions');
  assert.ok(!old.includes('-extension_picky'));
  assert.ok(!old.includes('-allowed_segment_extensions'));
  assert.ok(!old[old.indexOf('-protocol_whitelist')+1].split(',').includes('file'));
  assert.match(describeVideoError('URL is not in allowed_segment_extensions. Invalid data found',1),/segment filename/);
});

test('Python streamer and JavaScript probe use identical input options',async()=>{
  for(const help of ['allowed_extensions','allowed_extensions allowed_segment_extensions extension_picky']){
    const script='import json,sys;sys.path.insert(0,"runtime");from ffmpeg_options import hls_input_options;print(json.dumps(hls_input_options(sys.argv[1])))';
    const {stdout}=await run('python3',['-c',script,help]);
    assert.deepEqual(JSON.parse(stdout),hlsInputOptions(help));
  }
});

test('real FFmpeg decodes extensionless HLS and image-named TS segments', {timeout:30000}, async t=>{
  try{await run('ffmpeg',['-version']);await run('openssl',['version']);}
  catch{t.skip('FFmpeg and OpenSSL required for the media regression test');return;}
  const dir=await mkdtemp(join(tmpdir(),'camelot-hls-'));
  let server;
  try{
    await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost'],{timeout:10000});
    await run('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=64x64:rate=5','-t','1','-c:v','mpeg2video','-f','mpegts',join(dir,'segment.ts')],{timeout:10000});
    const segment=await readFile(join(dir,'segment.ts'));
    let segmentName='/ts?url=fixture',segmentRequests=0;
    server=createServer({key:await readFile(join(dir,'key.pem')),cert:await readFile(join(dir,'cert.pem'))},(req,res)=>{
      if(req.url==='/m3u8'){
        res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});
        res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\n${segmentName}\n#EXT-X-ENDLIST\n`);
      }else if(req.url===segmentName){segmentRequests++;res.writeHead(200,{'Content-Type':'image/jpeg'});res.end(segment);}
      else{res.writeHead(404);res.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url=`https://127.0.0.1:${server.address().port}/m3u8`;
    for(segmentName of ['/ts?url=fixture','/segment.jpg']){
      const {stdout}=await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error',...await ffmpegInputOptions(true),'-i',url,'-frames:v','1','-progress','pipe:1','-f','null','-'],{timeout:10000});
      assert.match(stdout,/(?:^|\n)frame=1\n/);
    }
    assert.ok(segmentRequests>=2);
  }finally{
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await rm(dir,{recursive:true,force:true});
  }
});
