// Backend-only client for the main Camelot bot. Never ship the key to Discord embeds.
export class CamelotTVClient {
 constructor({baseUrl,apiKey,guildId,fetcher=fetch}){
  const u=new URL(baseUrl);
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('Use the TV service origin as baseUrl');
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw new Error('Use HTTPS, or localhost when both services run on the same machine');
  if(typeof apiKey!=='string'||apiKey.length<32)throw new Error('A TV bridge key of at least 32 characters is required');
  if(!/^[0-9]{15,22}$/.test(String(guildId)))throw new Error('Invalid paired server ID');
  this.baseUrl=u.origin;this.apiKey=apiKey;this.guildId=String(guildId);this.fetcher=fetcher;
 }
 async request(path,body){
  const response=await this.fetcher(this.baseUrl+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.apiKey}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify({...body,guild:this.guildId})}:{}),signal:AbortSignal.timeout(240000),redirect:'error'});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'TV service request failed');return data;
 }
 state(){return this.request('/api/state');}
 search(query){return this.request(`/api/search?q=${encodeURIComponent(query)}&provider=all`);}
 episodes(selection,{refresh=false}={}){return this.request(`/api/episodes?provider=${encodeURIComponent(selection.provider)}&id=${encodeURIComponent(selection.id)}${refresh?'&refresh=1':''}`);}
 play(selection,episode,{channel,audio='sub',subtitles='en',checkOnly=false}={}){
  return this.request(checkOnly?'/api/check':'/api/play',{provider:selection.provider,media:selection.id,unit:episode.id,channel,lang:audio,subtitles});
 }
 stop(){return this.request('/api/stop',{});}
}
