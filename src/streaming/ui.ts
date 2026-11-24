import {ActionRowBuilder,ButtonStyle,MediaGalleryBuilder,MediaGalleryItemBuilder,ModalBuilder,StringSelectMenuBuilder,TextInputBuilder,TextInputStyle,escapeMarkdown,type GuildMember} from 'discord.js';
import {button,container,divider,heading,row,sectionWithThumb,selectRow,text} from '../core/ui.js';
import {Ids} from '../core/ids.js';
import {getSettings} from '../db/settings.js';
import {hasToken} from './store.js';
import {clock,type Session} from './model.js';

export function settingsCard(member:GuildMember){
  const s=getSettings(member.guild.id).streaming;
  return container().addTextDisplayComponents(heading('STREAMING'),text(`Account: **${hasToken(member.guild.id)?'Saved':'Not set'}**\nIdle timeout: **${s.idleSeconds}s** · Empty VC: **${s.emptySeconds}s**\nControls: **one person at a time** · Auto next: **${s.autoNext?'On':'Off'}**`))
    .addSeparatorComponents(divider()).addActionRowComponents(row(button('tvs:token','Save account'),button('tvs:clear','Remove account'),button('tvs:timers','Timeouts'),button('tvs:auto','Auto next: '+(s.autoNext?'On':'Off'))))
    .addActionRowComponents(row(button(Ids.settingsHome(),'Back')));
}
export function inputModal(id:string,title:string,label:string,placeholder:string,value?:string){
  const field=new TextInputBuilder().setCustomId('value').setLabel(label.slice(0,45)).setStyle(TextInputStyle.Short).setMaxLength(250).setRequired(true).setPlaceholder(placeholder.slice(0,100));
  if(value)field.setValue(value);
  return new ModalBuilder().setCustomId(id).setTitle(title.slice(0,45)).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
}
export function panel(s:Session,queue:number){
  const id=(op:string)=>`tv:${s.id}:${op}`;
  const b=(op:string,label:string,disabled=false)=>button(id(op),label).setDisabled(disabled);
  const ep=s.episodes[s.episode];
  const has=!!s.title&&!!ep;
  const time=`${clock(s.position)} / ${s.duration?clock(s.duration):'--:--'}`;
  const state={idle:'Ready',loading:'Loading…',playing:'Playing',paused:'Paused',offline:'Offline',error:'Try another source'}[s.phase];
  const detail=`${ep?`Episode ${ep.number} · ${s.lang.toUpperCase()} · `:''}${state}\n${has?'`'+time+'` · ':''}${s.actualSource||'Auto source'}${s.owner?'\nControls: <@'+s.owner+'>':''}`;
  const c=container();
  const title=escapeMarkdown(s.title?.title||'Camelot TV');
  if(s.title?.poster?.startsWith('https://'))c.addSectionComponents(sectionWithThumb(`## ${title}\n${detail}`,s.title.poster));
  else c.addTextDisplayComponents(heading(title,detail));
  if(s.phase!=='playing')c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://standby.gif').setDescription('Camelot TV status animation')));
  if(s.note)c.addTextDisplayComponents(text(s.note));
  c.addSeparatorComponents(divider()).addActionRowComponents(
    row(b('prev','Previous ep',!has||s.episode<=0),b('next','Next ep',!has||s.episode>=s.episodes.length-1),b('stop','Stop',!s.owner),b('play',s.phase==='playing'?'Pause':'Play',!has)),
    row(b('back','↶ 30 sec',!has||!s.duration),b('forward','30 sec ↷',!has||!s.duration),b('seek','Custom',!has||!s.duration),b('episode','Episode',!has)),
    row(b('search','Find anime'),b('lang',s.lang==='dub'?'Dub → Sub':'Sub → Dub'),b('queue',`My turn${queue?' · '+queue:''}`),b('release','Release',!s.owner)),
  );
  if(s.sources.length)c.addActionRowComponents(selectRow(new StringSelectMenuBuilder().setCustomId(id('source')).setPlaceholder('Switch source').addOptions(
    [{label:'Auto · try alternatives',value:'auto',default:s.source==='auto'},...s.sources.slice(0,24).map(p=>({label:p,value:p,default:s.source===p}))]
  )));
  return c;
}
