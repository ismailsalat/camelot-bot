const $=id=>document.getElementById(id);
let key='',remote=false,series=null,episodes=[],requesting=false,selectionEpoch=0;
const setMessage=(id,msg)=>{$(id).textContent=msg;};
const labels={sub:'Sub',dub:'Dub',raw:'Other audio'};
async function request(path,method='GET',payload=null){
 const opts={method,headers:key?{Authorization:`Bearer ${key}`}:{}};
 if(payload!==null){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(payload);}
 const r=await fetch(path,opts);let j;
 try{j=await r.json();}catch{throw new Error('Server returned an invalid response');}
 if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);
 return j;
}
function option(text,value){const o=document.createElement('option');o.value=value;o.textContent=text;return o;}
function selectedEpisode(){return episodes.find(e=>e.id===$('episode').value);}
function updateControls(){
 const ep=selectedEpisode();
 const unavailable=ep?.availability?.[$('language').value]?.status==='not-listed';
 for(const id of ['search','connect','test-online','refresh-sources','prev','next'])$(id).disabled=requesting;
 $('play').disabled=$('check-episode').disabled=requesting||!ep||unavailable;
 $('episode').disabled=$('language').disabled=$('subtitles').disabled=requesting;
}
function busy(value){requesting=value;updateControls();}
function fail(id,e){setMessage(id,e.message||String(e));}
function describeAvailability(){
 const ep=selectedEpisode();
 for(const o of $('language').options){
  const a=ep?.availability?.[o.value];
  o.disabled=a?.status==='not-listed';
  o.textContent=labels[o.value]+(a?.status==='not-listed'?' · not listed':a?.status==='unknown'?' · unknown':'');
 }
 if(!ep){setMessage('availability-message','Choose a title and episode first.');updateControls();return;}
 const parts=Object.entries(ep.availability||{}).map(([lang,a])=>{
  if(a.status==='listed')return `${labels[lang]} listed on ${a.providers.join(', ')}`;
  if(a.status==='unknown')return `${labels[lang]} availability unknown: some sources could not be checked`;
  return `${labels[lang]} not listed for this episode on the checked sources`;
 });
 setMessage('availability-message',parts.join(' · ')+'. Listed does not mean playback has been verified.');
 updateControls();
}
async function loadProviders(){
 const r=await request('/api/providers');const old=$('provider').value;
 $('provider').replaceChildren(option('All sources','all'),option('Anime catalog only','catalog'));
 for(const p of r.providers)$('provider').appendChild(option(p,p));
 if([...$('provider').options].some(o=>o.value===old))$('provider').value=old;
}
async function start(){
 try{const s=await request('/api/state');remote=s.cloud;$('remote-auth').classList.toggle('hidden',!remote);$('local-auth').classList.toggle('hidden',remote);await loadProviders();await refresh();}
 catch(e){if(/admin key/i.test(e.message)){remote=true;$('remote-auth').classList.remove('hidden');$('local-auth').classList.add('hidden');}else fail('play-message',e);}
 updateControls();
}
$('unlock').addEventListener('click',async()=>{
 key=$('admin').value.trim();$('admin').value='';try{await loadProviders();await refresh();setMessage('play-message','Controls unlocked.');}catch(e){fail('play-message',e);key='';}
});
$('connect').addEventListener('click',async()=>{
 busy(true);try{await request('/api/connect','POST',remote?{}:{guild:$('guild').value.trim(),token:$('token').value.trim()});$('token').value='';setMessage('play-message','Connecting to Discord...');}catch(e){fail('play-message',e);}finally{busy(false);}
});
$('disconnect').addEventListener('click',async()=>{try{await request('/api/disconnect','POST',{});setMessage('play-message','Disconnect requested.');}catch(e){fail('play-message',e);}});
function normName(v){return String(v||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function groupAnimeResults(results){
 const groups=[];
 for(const item of [...results.filter(x=>x.provider==='catalog'),...results.filter(x=>x.provider!=='catalog')]){
  const name=normName(item.title);if(!name)continue;
  let g=groups.find(g=>g.key===name&&(!g.year||!item.year||Math.abs(g.year-item.year)<=1));
  if(!g){g={key:name,year:item.year||null,item,sources:new Set()};groups.push(g);}
  if(item.provider!=='catalog')g.sources.add(item.provider);else g.item=item;
 }
 return groups;
}
async function doSearch(){
 if(requesting)return;selectionEpoch++;busy(true);series=null;episodes=[];$('results').replaceChildren();$('episode').replaceChildren(option('Choose a title',''));$('selected').textContent='No anime selected.';
 setMessage('search-message','Searching all selected sources...');describeAvailability();
 try{
  const r=await request(`/api/search?q=${encodeURIComponent($('query').value.trim())}&provider=${encodeURIComponent($('provider').value)}`);
  const groups=groupAnimeResults(r.results||[]),errors=(r.failures||[]).map(x=>`${x.provider} (${x.reason})`);
  setMessage('search-message',`${groups.length} titles · ${r.sourceCount||0} source listings`+(errors.length?` · Unavailable: ${errors.join(', ')}`:'')+'. Choose a season to check episodes and languages.');
  for(const g of groups){
   const button=document.createElement('div');button.className='result';button.setAttribute('role','button');button.tabIndex=0;
   const title=document.createElement('strong');title.textContent=g.item.title;
   const tag=document.createElement('small');tag.textContent=`${g.year||'Year unknown'} · ${g.sources.size} source listings`;
   button.append(title,tag);button.addEventListener('click',()=>chooseSeries(g.item,button));button.addEventListener('keydown',e=>{if(e.key==='Enter')chooseSeries(g.item,button);});$('results').appendChild(button);
  }
 }catch(e){fail('search-message',e);}finally{busy(false);}
}
async function chooseSeries(item,el,force=false){
 if(requesting)return;const epoch=++selectionEpoch,previous=selectedEpisode()?.number;
 busy(true);series=item;episodes=[];
 if(el){document.querySelectorAll('.result').forEach(x=>x.classList.remove('active'));el.classList.add('active');}
 $('selected').textContent=item.title;$('episode').replaceChildren(option('Checking sources and languages...',''));
 setMessage('availability-message','Checking the matching season and episode lists across all enabled sources...');
 try{
  const r=await request(`/api/episodes?provider=${encodeURIComponent(item.provider)}&id=${encodeURIComponent(item.id)}${force?'&refresh=1':''}`);
  if(epoch!==selectionEpoch)return;
  series=r.selection;episodes=r.episodes;$('selected').textContent=series.title;$('episode').replaceChildren();
  for(const ep of episodes){
   const langs=['sub','dub'].map(l=>ep.availability[l].status==='listed'?labels[l]:ep.availability[l].status==='unknown'?labels[l]+'?':null).filter(Boolean).join(' / ');
   $('episode').appendChild(option(`Episode ${ep.number}: ${ep.title} · ${langs}`,ep.id));
  }
  if(force&&episodes.some(e=>e.number===previous))$('episode').value=`episode:${previous}`;
  describeAvailability();setMessage('play-message',`${episodes.length} episodes checked across ${r.sources.length} matching source listings. Select audio and subtitles, then Check Episode or Play.`);
 }catch(e){if(epoch===selectionEpoch){episodes=[];$('episode').replaceChildren(option('No episodes available',''));fail('play-message',e);}}
 finally{if(epoch===selectionEpoch){busy(false);describeAvailability();}}
}
async function play(checkOnly=false){
 if(requesting)return;const ep=selectedEpisode();if(!series||!ep)return;
 const channel=$('voice').value;if(!checkOnly&&!channel)return setMessage('play-message','Choose a voice channel first.');
 busy(true);setMessage('play-message',`Checking ${labels[$('language').value]} sources and selected subtitles. See the activity log...`);
 try{
  const r=await request(checkOnly?'/api/check':'/api/play','POST',{provider:series.provider,media:series.id,unit:ep.id,lang:$('language').value,subtitles:$('subtitles').value,channel});
  const captions=r.subtitle?.mode==='burned'?`${r.subtitle.label} subtitles rendered into video`:'Separate subtitles off';
  setMessage('play-message',`${r.message} ${labels[r.language]} · ${r.provider} · ${captions}.`);
 }catch(e){fail('play-message',e);}finally{busy(false);}
}
$('play').addEventListener('click',()=>play(false));$('check-episode').addEventListener('click',()=>play(true));
$('search').addEventListener('click',doSearch);$('query').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
$('refresh-sources').addEventListener('click',()=>{if(series)chooseSeries(series,null,true);});
$('episode').addEventListener('change',describeAvailability);$('language').addEventListener('change',describeAvailability);
function step(n){if(requesting)return;const i=episodes.findIndex(e=>e.id===$('episode').value);if(i<0)return;$('episode').selectedIndex=Math.min(episodes.length-1,Math.max(0,i+n));describeAvailability();}
$('prev').addEventListener('click',()=>step(-1));$('next').addEventListener('click',()=>step(1));
$('stop').addEventListener('click',async()=>{try{await request('/api/stop','POST',{});setMessage('play-message','Stop requested.');}catch(e){fail('play-message',e);}});
$('test-online').addEventListener('click',async()=>{
 const channel=$('voice').value;if(!channel)return setMessage('play-message','Choose a voice channel first.');
 busy(true);try{const r=await request('/api/test-online','POST',{channel});setMessage('play-message',r.message);}catch(e){fail('play-message',e);}finally{busy(false);}
});
async function refresh(){
 try{
  const s=await request('/api/state');$('banner').textContent=`v${s.version||'older server'} · ${s.status}`+(s.account?' · '+s.account:'');
  const current=$('voice').value,channels=s.channels||[];
  if(channels.map(x=>x.id).join('|')!==[...$('voice').options].filter(x=>x.value).map(x=>x.value).join('|')){
   $('voice').replaceChildren(option(channels.length?'Choose a VC':'Connect first',''));for(const c of channels)$('voice').appendChild(option(c.name,c.id));if(channels.some(c=>c.id===current))$('voice').value=current;
  }
  const list=$('log-list'),atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<40;list.replaceChildren();
  for(const l of s.logs||[]){const e=document.createElement('div');e.className='rowlog '+l.kind;e.textContent=`${l.time} [${l.kind}] ${l.msg}`;list.appendChild(e);}
  if(atBottom)list.scrollTop=list.scrollHeight;
 }catch(e){$('banner').textContent=e.message||'Offline';}
}
$('refresh').addEventListener('click',refresh);setInterval(refresh,3000);start();
