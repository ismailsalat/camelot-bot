import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMediaUrl,cleanHeaders,rankedStreams,isPublicIP,ffmpegHeaderArgs} from '../src/source.mjs';
test('reject unsafe hosts, schemes and embedded credentials',()=>{
  for(const u of ['http://x.com/video.mp4','https://127.0.0.1/a.mp4','https://localhost/a.m3u8',
    'https://foo.internal/a.m3u8','https://a:b@cdn.testsite.com/video.mp4','file:///etc/passwd',
    'https://10.0.0.1/x','https://good.com:8443/video.mp4']) assert.equal(validateMediaUrl(u),null,u);
  assert.ok(validateMediaUrl('https://cdn.example.com/episode.m3u8?sig=abc&expires=123'));
});
test('filter headers',()=>{assert.deepEqual(cleanHeaders({Referer:'https://example.com/',Authorization:'xxx','X-Test':'x'}),{Referer:'https://example.com/'});
 assert.deepEqual(ffmpegHeaderArgs({Referer:'https://example.com/'}),['-headers','Referer: https://example.com/\r\n']);});
test('prefer 720p then 480p and avoid unsafe URLs',()=>{
 let a=rankedStreams([{sourceUrl:'https://cdn.example.com/1080.mp4',quality:'1080p'},
 {sourceUrl:'https://cdn.example.com/720.mp4',quality:'720p'},
 {sourceUrl:'http://127.0.0.1/private',quality:'auto'}]);
 assert.equal(a.length,2);assert.equal(a[0].quality,'720p');
});
test('public address checks',()=>{assert.equal(isPublicIP('127.0.0.1'),false);assert.equal(isPublicIP('10.10.1.2'),false);assert.equal(isPublicIP('1.1.1.1'),true);});
