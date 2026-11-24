// Additional independent adapters. Availability is checked on every request;
// registration is not a claim that an external site is currently reachable.
import {ANIME} from '@consumet/extensions';
const CLASSES={animepahe:ANIME.AnimePahe,animekai:ANIME.AnimeKai,kickassanime:ANIME.KickAssAnime};
export const EXTRA_IDS=Object.keys(CLASSES);
export class ExtraProvider {
 constructor(id){this.id=id;this.api=new CLASSES[id]();if(this.api.client?.defaults)this.api.client.defaults.timeout=16000;}
 raw(id){if(typeof id!=='string'||!id.startsWith(this.id+':'))throw new Error('Invalid source id');return id.slice(this.id.length+1)}
 async search(query){
  const result=await this.api.search(query);
  return (result.results||[]).map(r=>({id:this.id+':'+r.id,title:typeof r.title==='string'?r.title:r.title?.english||r.title?.romaji||'',thumbnailUrl:r.image,year:parseInt(r.releaseDate)||null,availableLanguages:[]}));
 }
 async fetchContentUnits(media){
  const info=await this.api.fetchAnimeInfo(this.raw(media));
  return (info.episodes||[]).map(e=>({id:this.id+':'+e.id,number:Number(e.number),title:e.title||`Episode ${e.number}`,availableLanguages:this.id==='kickassanime'?['sub']:[]}));
 }
 async resolveStream(unit,lang){
  if(!['sub','dub'].includes(lang))throw new Error('Unsupported language');
  // KAA's current adapter does not expose an audio locale selector. Never
  // advertise its default Japanese track as an English dub.
  if(this.id==='kickassanime'&&lang!=='sub')throw new Error('This adapter cannot select English audio');
  const raw=this.raw(unit);
  const result=this.id==='animekai'?await this.api.fetchEpisodeSources(raw,undefined,lang):await this.api.fetchEpisodeSources(raw);
  const streams=(result.sources||[]).filter(s=>!s.isDASH&&(this.id!=='animepahe'||s.isDub===(lang==='dub'))).map(s=>({
   sourceUrl:s.url,quality:s.quality||'auto',isHLS:!!s.isM3U8,language:lang,headers:result.headers||{},
   subtitles:(result.subtitles||[]).map(t=>({url:t.url,language:/english|\ben\b/i.test(t.lang||'')?'en':t.lang,label:t.lang}))
  }));
  return {type:'video',streams};
 }
}
