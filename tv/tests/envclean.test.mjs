import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanStreamEnv} from '../src/envclean.mjs';
test("a stray apostrophe on the bitrate (the Railway bug) is removed",()=>{
  const {env,fixes}=cleanStreamEnv({STREAM_VIDEO_BITRATE:"6000k'"});
  assert.equal(env.STREAM_VIDEO_BITRATE,'6000k');assert.match(fixes[0],/stray quotes/);
});
test('quotes and spaces around every knob are stripped',()=>{
  const {env}=cleanStreamEnv({STREAM_RESOLUTION:' "1280x720" ',STREAM_FPS:"'30'",STREAM_X264_PRESET:' VeryFast ',STREAM_FFMPEG_THREADS:'4 ',STREAM_QUALITY:'720P'});
  assert.deepEqual(env,{STREAM_RESOLUTION:'1280:720',STREAM_FPS:'30',STREAM_X264_PRESET:'veryfast',STREAM_FFMPEG_THREADS:'4',STREAM_QUALITY:'720p'});
});
test('invalid values are dropped with an explanation instead of reaching FFmpeg',()=>{
  const {env,fixes}=cleanStreamEnv({STREAM_VIDEO_BITRATE:'fast',STREAM_FPS:'500',STREAM_RESOLUTION:'big',STREAM_X264_PRESET:'placebo',STREAM_FFMPEG_THREADS:'0',OTHER:'x'});
  assert.deepEqual(env,{OTHER:'x'});assert.equal(fixes.length,5);assert(fixes.every(f=>/default/.test(f)));
});
test('valid and unset values pass through untouched',()=>{
  const input={STREAM_VIDEO_BITRATE:'8000k',STREAM_RESOLUTION:'1920:1080',PATH:'/bin'};
  const {env,fixes}=cleanStreamEnv(input);assert.deepEqual(env,input);assert.deepEqual(fixes,[]);
});
