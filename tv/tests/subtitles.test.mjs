import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pickSubtitle,detectSubtitleFormat,fetchSubtitle,prepareSubtitleText,subtitleFilter,discardCaptions} from '../src/subtitles.mjs';
const run=promisify(execFile);
const text='WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nCamelot captions test\n';
test('English label/code matching prefers dialogue over signs',()=>{
 const tracks=[{language:'en',label:'English signs'},{language:'english',label:'English'},{language:'ar',label:'Arabic'}];
 assert.equal(pickSubtitle(tracks,'en').label,'English');assert.equal(pickSubtitle(tracks,'ar').label,'Arabic');assert.equal(pickSubtitle(tracks,'off'),null);
 assert.equal(pickSubtitle([{language:'es-ES',label:'Spanish'}],'es').label,'Spanish');
});
test('reject HTML and playlists masquerading as captions',()=>{
 assert.equal(detectSubtitleFormat(text),'webvtt');
 for(const body of ['<html>blocked</html>','#EXTM3U\nhttps://example.com/file.ts'])assert.throws(()=>detectSubtitleFormat(body));
 assert.throws(()=>subtitleFilter("/tmp/evil',movie=/etc/passwd.ass"));
});
test('subtitle fetch rejects unsafe redirects and bounded response size',async()=>{
 const checkHost=async()=>{};
 await assert.rejects(fetchSubtitle('https://cdn.example.com/en.vtt',{}, {checkHost,fetcher:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})}),/redirect rejected/);
 await assert.rejects(fetchSubtitle('https://cdn.example.com/en.vtt',{}, {checkHost,fetcher:async()=>new Response(text,{headers:{'content-length':'9000000'}})}),/too large/);
 assert.equal(await fetchSubtitle('https://cdn.example.com/en.vtt',{}, {checkHost,fetcher:async()=>new Response(text)}),text);
});
test('real caption renderer changes visible pixels on a generated video frame',async()=>{
 const files=await prepareSubtitleText(text);
 try{
  const base=['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=640x360:r=1','-frames:v','1'];
  const a=await run('ffmpeg',[...base,'-f','framemd5','-']);
  const b=await run('ffmpeg',[...base,'-vf',subtitleFilter(files.subtitlePath),'-f','framemd5','-']);
  assert.notEqual(a.stdout.split('\n').filter(x=>!x.startsWith('#')).join(''),b.stdout.split('\n').filter(x=>!x.startsWith('#')).join(''));
 }finally{await discardCaptions(files);}
});
