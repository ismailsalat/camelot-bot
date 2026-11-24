import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMaster,pickVariant,chooseVariantUrl} from '../src/variants.mjs';

const master=`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6200000,RESOLUTION=1920x1080
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
360/index.m3u8
`;
const base='https://cdn.example.com/v/master.m3u8';

test('a 720p picture uses the 720p stream, not the 1080p one FFmpeg would take by default',()=>{
  const pick=pickVariant(parseMaster(master,base),720);
  assert.equal(pick.height,720);assert.equal(pick.url,'https://cdn.example.com/v/720/index.m3u8');assert.deepEqual(pick.of,[1080,720,360]);
});
test('a 1080p picture keeps the top quality (no change)',()=>{assert.equal(pickVariant(parseMaster(master,base),1080),null)});
test('separate audio playlists, single qualities and unknown sizes are left alone',()=>{
  assert.equal(pickVariant(parseMaster(`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="aud.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="a"\nv1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO="a"\nv2.m3u8\n`,base),720),null);
  assert.equal(pickVariant(parseMaster(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nonly.m3u8\n`,base),720),null);
  assert.equal(pickVariant(parseMaster(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nb.m3u8\n`,base),720),null);
  assert.equal(pickVariant(parseMaster(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5,RESOLUTION=1920x1080\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1440x810\nb.m3u8\n`,base),720),null);
});
test('chooseVariantUrl only returns a variant whose playlist really has segments, and never throws',async()=>{
  const media=`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n`;
  const fake=pages=>async url=>{const t=pages[url];return t===undefined?new Response('no',{status:404}):new Response(t,{status:200})};
  const io=pages=>({fetcher:fake(pages),checkHost:async()=>{}});
  const ok=await chooseVariantUrl(base,{},{target:720,...io({[base]:master,'https://cdn.example.com/v/720/index.m3u8':media})});
  assert.equal(ok.height,720);
  assert.equal(await chooseVariantUrl(base,{},{target:720,...io({[base]:master})}),null);                       // variant playlist missing
  assert.equal(await chooseVariantUrl(base,{},{target:720,...io({[base]:master,'https://cdn.example.com/v/720/index.m3u8':'<html>'})}),null);
  assert.equal(await chooseVariantUrl(base,{},{target:720,...io({[base]:media})}),null);                        // already a media playlist
  assert.equal(await chooseVariantUrl('http://127.0.0.1/x.m3u8',{},{target:720,...io({})}),null);               // unsafe URL
});
