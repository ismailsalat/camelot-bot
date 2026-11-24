import {ActionRowBuilder,ButtonStyle,MediaGalleryBuilder,MediaGalleryItemBuilder,ModalBuilder,StringSelectMenuBuilder,TextInputBuilder,TextInputStyle,escapeMarkdown,type GuildMember} from 'discord.js';
import {button,container,divider,heading,row,sectionWithThumb,selectRow,text} from '../core/ui.js';
import {Ids} from '../core/ids.js';
import {getSettings} from '../db/settings.js';
import {tokenSource} from './store.js';
import {clock,type Session} from './model.js';
import {upNext} from './queue.js';
import {seasonText} from './seasons.js';

export function settingsCard(member:GuildMember){
  const settings=getSettings(member.guild.id),s=settings.streaming;
  return container().addTextDisplayComponents(heading('STREAMING'),text(`Streaming: **${settings.modules.streaming?'On':'Off'}**\nAccount: **${tokenSource(member.guild.id)}**\nIdle timeout: **${s.idleSeconds}s** · Empty VC: **${s.emptySeconds}s**\nControls: **one person at a time** · Auto next: **${s.autoNext?'On':'Off'}**`))
    .addTextDisplayComponents(text((settings.modules.streaming?'Join a VC and use /stream or !stream.':'Streaming is off. Press **Turn on Streaming** below, then **Save account**.')+' Saved tokens stay hidden; an empty token form does not mean the account was removed.'))
    .addSeparatorComponents(divider()).addActionRowComponents(row(button('tvs:token','Save account'),button('tvs:clear','Remove saved account'),button('tvs:timers','Timeouts'),button('tvs:auto','Auto next: '+(s.autoNext?'On':'Off')),button('tvs:debugmode','Detailed stats (5 min)')))
    .addActionRowComponents(row(button('tvs:toggle',settings.modules.streaming?'Turn off Streaming':'Turn on Streaming',settings.modules.streaming?ButtonStyle.Secondary:ButtonStyle.Success),button('tvs:check','Check account'),button('tvs:debug','Debug info'),button('tvs:export','Export diagnostics'),button(Ids.settingsHome(),'Back')));
}
export function inputModal(id:string,title:string,label:string,placeholder:string,value?:string){
  const field=new TextInputBuilder().setCustomId('value').setLabel(label.slice(0,45)).setStyle(TextInputStyle.Short).setMaxLength(250).setRequired(true).setPlaceholder(placeholder.slice(0,100));
  if(value)field.setValue(value);
  return new ModalBuilder().setCustomId(id).setTitle(title.slice(0,45)).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
}
/** ━━━━●────── style progress bar. */
export function progressBar(position:number,duration:number|null,width=18):string{
  if(!duration||duration<=0)return '─'.repeat(width);
  const at=Math.max(0,Math.min(width-1,Math.floor((Math.max(0,position)/duration)*width)));
  return '━'.repeat(at)+'●'+'─'.repeat(width-1-at);
}
const EP_PAGE=23;
export function episodePage(s:Session):number{
  const last=Math.max(0,Math.ceil(s.episodes.length/EP_PAGE)-1);
  return Math.max(0,Math.min(last,s.epPage??Math.floor(s.episode/EP_PAGE)));
}
/** Dropdown options for the episode list; long shows are split into pages of 23 plus "earlier/later" entries. */
export function episodeOptions(s:Session):Array<{label:string;value:string;description?:string;default?:boolean}>{
  const total=s.episodes.length;
  const paged=total>25,page=paged?episodePage(s):0;
  const from=paged?page*EP_PAGE:0,to=paged?Math.min(total,from+EP_PAGE):total;
  const out:Array<{label:string;value:string;description?:string;default?:boolean}>=[];
  if(paged&&from>0)out.push({label:`◀ Earlier episodes (${s.episodes[Math.max(0,from-EP_PAGE)]!.number}–${s.episodes[from-1]!.number})`,value:`page:${page-1}`});
  for(let n=from;n<to;n++){
    const e=s.episodes[n]!;const name=(e.title||'').replace(/\s+/g,' ').trim();
    const langs=(e.languages||[]).map(l=>l.toUpperCase()).join(' · ');
    out.push({label:`Episode ${e.number}${name&&!/^episode \d+$/i.test(name)?` · ${name}`:''}`.slice(0,100),value:String(n),description:langs||undefined,default:n===s.episode});
  }
  if(paged&&to<total)out.push({label:`Later episodes (${s.episodes[to]!.number}–${s.episodes[Math.min(total,to+EP_PAGE)-1]!.number}) ▶`,value:`page:${page+1}`});
  return out;
}
export function seasonOptions(s:Session):Array<{label:string;value:string;description?:string;default?:boolean}>{
  const family=s.title?.family||[];
  return family.slice(0,25).map((f,n)=>{
    const tag=f.season===0?'Special':`Season ${f.season}`;
    const nameLabel=f.title.toLowerCase().includes(tag.toLowerCase())?f.title:`${tag} · ${f.title}`;
    const bits=[f.count?`${f.count} episodes`:'',f.year?String(f.year):''].filter(Boolean).join(' · ');
    const current=(f.id===s.title?.id&&f.provider===s.title?.provider)||(f.season!==undefined&&f.season===s.title?.season);
    return {label:nameLabel.slice(0,100),value:String(n),description:bits||undefined,default:current};
  });
}
export function panel(s:Session,queue:number){
  const id=(op:string)=>`tv:${s.id}:${op}`;
  const b=(op:string,label:string,disabled=false)=>button(id(op),label).setDisabled(disabled);
  const ep=s.episodes[s.episode];
  const has=!!s.title&&!!ep;
  const busy=s.phase==='loading';
  const canSeek=has&&!!s.duration&&['playing','paused'].includes(s.phase);
  const state={idle:s.owner?'Ready':'Available',loading:'⏳ Loading…',playing:'▶ Playing',paused:'⏸ Paused',offline:'Offline',error:'Try another source'}[s.phase];
  const season=seasonText(s.title);
  const total=s.episodes.length;
  const where=has?[season,`Episode ${ep!.number} of ${total}`,s.lang.toUpperCase(),s.phase==='playing'||s.phase==='paused'?(s.subtitle||''):'',s.phase==='playing'||s.phase==='paused'?(s.quality||'720p'):''].filter(Boolean).join(' · '):'';
  const showBar=has&&!!s.duration&&['playing','paused','loading'].includes(s.phase);
  const progress=showBar?`${progressBar(s.position,s.duration)}  \`${clock(s.position)} / ${clock(s.duration!)}\``:'';
  const lines=[where,progress,[state,s.actualSource||''].filter(Boolean).join(' · '),s.owner?`Controls: <@${s.owner}>`:''].filter(Boolean);
  const detail=lines.join('\n')+upNext(s);
  const c=container();
  const title=escapeMarkdown((s.title?.title||'Camelot TV').slice(0,160));
  if(s.title?.poster?.startsWith('https://'))c.addSectionComponents(sectionWithThumb(`## ${title}\n${detail}`,s.title.poster));
  else c.addTextDisplayComponents(heading(title,detail));
  if(s.phase!=='playing')c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://standby.gif').setDescription('Camelot TV status animation')));
  if(s.note)c.addTextDisplayComponents(text(s.note));
  const top=[b('prev','Previous',busy||!has||s.episode<=0),b('play',s.phase==='playing'?'Pause':'Play',busy||!has),b('next','Next',busy||!has||s.episode>=total-1),b('stop','Stop',!s.owner)];
  if(s.hd&&['playing','paused'].includes(s.phase))top.push(b('quality',s.quality==='1080p'?'Use 720p':'Use 1080p',busy));
  c.addSeparatorComponents(divider()).addActionRowComponents(
    row(...top),
    row(b('seek','Jump to time',!canSeek),b('lang',s.lang==='dub'?'Dub → Sub':'Sub → Dub',busy),b('search','Find anime',busy),b('lineup',`Queue${s.queue?.length?' · '+s.queue.length:''}`,!s.owner),b('queue',`My turn${queue?' · '+queue:''}`)),
  );
  if((s.title?.family?.length||0)>1)c.addActionRowComponents(selectRow(new StringSelectMenuBuilder().setCustomId(id('season')).setPlaceholder('Season').setDisabled(busy).addOptions(seasonOptions(s))));
  if(total>1)c.addActionRowComponents(selectRow(new StringSelectMenuBuilder().setCustomId(id('epsel')).setPlaceholder(`Episode · ${total} total`).setDisabled(busy).addOptions(episodeOptions(s))));
  // Switching source is a recovery tool, so it only appears when playback has failed.
  if(s.phase==='error'&&s.sources.length)c.addActionRowComponents(selectRow(new StringSelectMenuBuilder().setCustomId(id('source')).setPlaceholder('Try another source').addOptions(
    [{label:'Auto · try alternatives',value:'auto',default:s.source==='auto'},...s.sources.slice(0,24).map(p=>({label:p,value:p,default:s.source===p}))]
  )));
  return c;
}
