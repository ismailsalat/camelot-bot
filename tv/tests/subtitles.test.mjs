import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pickSubtitle,detectSubtitleFormat,fetchSubtitle,prepareSubtitleText,subtitleFilter,discardCaptions,describeTracks} from '../src/subtitles.mjs';
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
test('English captions are found under the labels sources really use',()=>{
 for(const label of ['English (CC)','English - Subs','[English]','English [US]','ENGLISH','eng'])
  assert.equal(pickSubtitle([{language:label.toLowerCase(),label,url:'https://x/a.vtt'}],'en')?.label,label,label);
 assert.equal(pickSubtitle([{label:'Thumbnails'},{label:'Portuguese - Brazil'},{label:'Español'}],'en'),null);
 assert.deepEqual(describeTracks([{label:'English'},{language:'ar'},{}]),['English','ar','?']);
});
test('prepared English captions really change the picture when burned in by FFmpeg',async()=>{
 try{await run('ffmpeg',['-hide_banner','-filters'],{maxBuffer:1e6}).then(r=>{if(!/\bass\b/.test(r.stdout))throw new Error('no libass')})}catch{return}
 const prepared=await prepareSubtitleText('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nCamelot burned-in caption\n');
 try{
  const grab=async vf=>(await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=640x360:d=2:r=10','-vf',vf,'-frames:v','1','-f','rawvideo','-pix_fmt','gray','-'],{encoding:'buffer',maxBuffer:1e7})).stdout;
  const plain=await grab('null'),burned=await grab(subtitleFilter(prepared.subtitlePath));
  let changed=0;for(let i=0;i<burned.length;i++)if(burned[i]!==plain[i])changed++;
  assert.ok(changed>200,`only ${changed} pixels changed`);
 }finally{await discardCaptions(prepared)}
});
