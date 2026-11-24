import {ActionRowBuilder,ButtonBuilder,ButtonStyle,StringSelectMenuBuilder,escapeMarkdown} from 'discord.js';
import type {Session,Title} from './model.js';

export const MAX_QUEUE=20;
const same=(a:Title,b:Title)=>a.id===b.id&&a.provider===b.provider;

export function addToQueue(s:Session,title:Title):'added'|'duplicate'|'full'{
  s.queue??=[];
  if(s.title&&same(s.title,title))return 'duplicate';
  if(s.queue.some(t=>same(t,title)))return 'duplicate';
  if(s.queue.length>=MAX_QUEUE)return 'full';
  s.queue.push({id:title.id,provider:title.provider,title:title.title,poster:title.poster,aliases:title.aliases,year:title.year,count:title.count,season:title.season,family:title.family});
  return 'added';
}
export function removeFromQueue(s:Session,index:number):Title|null{
  if(!s.queue||!Number.isInteger(index)||index<0||index>=s.queue.length)return null;
  return s.queue.splice(index,1)[0]!;
}
export function takeNext(s:Session):Title|null{return s.queue?.shift()??null}

/** One short line for the main panel, or '' when nothing is queued. */
export function upNext(s:Session):string{
  const q=s.queue??[];if(!q.length)return '';
  const names=q.slice(0,3).map((t,i)=>`${i+1}. ${escapeMarkdown(t.title.slice(0,38))}`).join(' · ');
  return `\nUp next: ${names}${q.length>3?` · +${q.length-3} more`:''}`;
}

/** The private queue manager shown from the panel's Queue button. */
export function queueView(s:Session,note=''){
  const q=s.queue??[];
  const lines=[`**Queue** · ${q.length}/${MAX_QUEUE}`];
  if(s.title)lines.push(`Now: ${escapeMarkdown(s.title.title.slice(0,60))}${s.episodes[s.episode]?` · episode ${s.episodes[s.episode]!.number}`:''}`);
  lines.push(q.length?q.map((t,i)=>`${i+1}. ${escapeMarkdown(t.title.slice(0,60))}`).join('\n'):'_Nothing queued yet._');
  lines.push('Anyone in the voice channel can add anime. The controller or an admin can remove, clear or skip ahead. Each queued anime starts on its own when the one before it ends.');
  if(note)lines.push(`\n${note}`);
  const id=(op:string)=>`tv:${s.id}:${op}`;
  const components:any[]=[new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id('qadd')).setLabel('Add anime').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(id('qskip')).setLabel('Play next now').setStyle(ButtonStyle.Secondary).setDisabled(!q.length),
    new ButtonBuilder().setCustomId(id('qclear')).setLabel('Clear queue').setStyle(ButtonStyle.Secondary).setDisabled(!q.length),
  )];
  if(q.length)components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(id('qdel')).setPlaceholder('Remove one from the queue').addOptions(q.slice(0,25).map((t,i)=>({label:`${i+1}. ${t.title}`.slice(0,100),value:String(i)})))));
  return {content:lines.join('\n').slice(0,1900),components};
}

/** True when a message carries the Streaming panel's buttons (custom ids `tv:<session>:<op>`). */
export function hasPanelControls(components:any[]|undefined):boolean{
  try{return /"custom_id":"tv:[0-9a-f]{12}:/.test(JSON.stringify((components??[]).map((c:any)=>typeof c?.toJSON==='function'?c.toJSON():c)))}
  catch{return false}
}
