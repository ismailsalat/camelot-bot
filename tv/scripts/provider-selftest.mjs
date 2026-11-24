#!/usr/bin/env node
// Provider self-test. Run it where the bot runs (Railway), not on a laptop:  railway ssh -- node tv/scripts/provider-selftest.mjs
// For every enabled provider and every test case it records: when, title/episode/language, search+resolve time, media format,
// and whether FFmpeg decoded a real video frame. Nothing here prints a media URL or header. Exit code is always 0; read the table.
//   CAMELOT_SELFTEST_CASES='[{"title":"Hunter x Hunter","year":2011,"episode":1,"lang":"sub"}]'   CAMELOT_SELFTEST_PROVIDERS=megaplay,hianime
import {getProviders,searchCatalog,listEpisodes,resolveEpisode} from '../src/sdk.mjs';
import {rankedStreams,preflightVideo} from '../src/source.mjs';
import {sameAnime} from '../src/catalog.mjs';
import {health,classifyFailure} from '../src/health.mjs';
import {redactText} from '../src/timeline.mjs';

const cases=JSON.parse(process.env.CAMELOT_SELFTEST_CASES||'null')||[
  {title:'Hunter x Hunter',year:2011,episode:1,lang:'sub'},
  {title:'Hunter x Hunter',year:2011,episode:1,lang:'dub'},
  {title:'Naruto',episode:1,lang:'sub'},
  {title:'One Piece',episode:1,lang:'sub'},
  {title:'Dr. Stone',episode:1,lang:'sub'},
];
const only=(process.env.CAMELOT_SELFTEST_PROVIDERS||'').split(',').map(x=>x.trim()).filter(Boolean);
const format=url=>/\.m3u8(\?|$)/i.test(url)?'hls':/\.mpd(\?|$)/i.test(url)?'dash':/\.(mp4|webm|mkv)(\?|$)/i.test(url)?'file':'unknown';
const ms=started=>Math.round(performance.now()-started);
const rows=[];
const providers=[...(await getProviders()).keys()].filter(p=>!only.length||only.includes(p));
for(const c of cases){
  for(const provider of providers){
    const row={testedAt:new Date().toISOString(),provider,title:c.title+(c.year?` (${c.year})`:''),episode:c.episode,lang:c.lang,
      searchMs:null,resolveMs:null,format:null,videoFrame:null,class:null,note:null};
    try{
      let t=performance.now();
      const found=await searchCatalog(c.title,provider);row.searchMs=ms(t);
      const want={title:c.title,year:c.year};
      const hit=found.results.find(r=>sameAnime(want,r));
      if(!hit){row.class=found.failures[0]?.class||'wrong_title';row.note=found.failures[0]?.reason||`no exact-title match among ${found.results.length} result(s)`;rows.push(row);continue}
      const eps=await listEpisodes(provider,hit.id);
      const ep=eps.filter(e=>e.number===c.episode&&(!e.languages.length||e.languages.includes(c.lang)));
      if(ep.length!==1){row.class='unavailable_episode';row.note=ep.length?'ambiguous episode':`episode/language not listed (${eps.length} listed)`;rows.push(row);continue}
      t=performance.now();
      const resolved=await resolveEpisode(provider,ep[0].id,c.lang);
      const streams=rankedStreams(resolved,c.lang);row.resolveMs=ms(t);
      if(!streams.length){row.class='parser';row.note='no direct video URL';rows.push(row);continue}
      row.format=format(streams[0].url);
      if(row.format==='dash'){row.class='manifest';row.note='DASH is not enabled until validated';rows.push(row);continue}
      await preflightVideo(streams[0].url,streams[0].headers,30000,{isHLS:streams[0].isHLS});
      row.videoFrame=true;health.success(provider,{ms:row.resolveMs});
    }catch(e){row.videoFrame=false;row.class=classifyFailure(e);row.note=redactText(e?.message).slice(0,140);health.failure(provider,e)}
    rows.push(row);
  }
}
console.log(JSON.stringify({testedAt:new Date().toISOString(),environment:process.env.RAILWAY_ENVIRONMENT?'railway':'other',commit:(process.env.RAILWAY_GIT_COMMIT_SHA||'').slice(0,12)||null,rows},null,1));
console.error('\nprovider        case                       lang  search  resolve  format  frame  class');
for(const r of rows)console.error(`${r.provider.padEnd(15)} ${(r.title+' e'+r.episode).slice(0,26).padEnd(26)} ${r.lang.padEnd(5)} ${String(r.searchMs??'-').padStart(6)} ${String(r.resolveMs??'-').padStart(8)}  ${(r.format||'-').padEnd(6)} ${String(r.videoFrame??'-').padEnd(6)} ${r.class||'ok'}`);
