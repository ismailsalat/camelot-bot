import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {ActionRowBuilder,AttachmentBuilder,ChannelType,MessageFlags,PermissionFlagsBits,StringSelectMenuBuilder,type Client,type GuildMember,type Interaction,type Message,type VoiceChannel} from 'discord.js';
import {getSettings,setByPath} from '../db/settings.js';
import {isAdmin} from '../core/permissions.js';
import {NO_MENTIONS} from '../util/mentions.js';
import {V2_FLAGS,V2_PUBLIC} from '../core/ui.js';
import {log} from '../logger.js';
import {Bridge,type WorkerState} from './bridge.js';
import {Gate,boundedPosition,clock,seconds,type Session,type Title} from './model.js';
import {clearToken,getToken,restoreSession,saveSession,saveToken} from './store.js';
import {inputModal,panel,settingsCard} from './ui.js';

type Waiter={guild:string;user:string;channel:string};
export class Streaming {
  private bridge=new Bridge();
  private gate=new Gate();
  private session:Session|null=null;
  private queue:Waiter[]=[];
  private client:Client|null=null;
  private timer:NodeJS.Timeout|null=null;
  private repaint:NodeJS.Timeout|null=null;
  private painting=false;
  private polling=false;
  private bump=false;
  private lastBump=0;
  private emptyAt=0;
  private absentAt=0;
  private retries=0;
  private lastPosition=0;
  private lastMotion=Date.now();
  private closed=false;
  private searchResults=new Map<string,{owner:string;session:string;rows:Title[];expires:number}>();
  async start(client:Client){
    this.client=client;this.session=restoreSession();
    if(this.session){Object.assign(this.session,{owner:null,phase:'offline',note:'Restarted. Press Play to resume, or Find anime.',changed:Date.now()});saveSession(this.session);await this.paint();}
    this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref();
  }
  private async channel():Promise<VoiceChannel|null>{
    if(!this.client||!this.session)return null;
    const ch=await this.client.channels.fetch(this.session.channel).catch(()=>null);
    return ch?.type===ChannelType.GuildVoice?ch:null;
  }
  private persist(){if(this.session)saveSession(this.session)}
  private async paint(){
    if(this.painting||!this.session)return;
    this.painting=true;
    try{
      const s=this.session,ch=await this.channel();if(!ch)return;
      const old=s.message?await ch.messages.fetch(s.message).catch(()=>null):null;
      const payload={components:[panel(s,this.queue.length)],flags:V2_PUBLIC,allowedMentions:NO_MENTIONS,
        files:s.phase==='playing'||(old&&!this.bump&&old.attachments.some(a=>a.name==='standby.gif'))?[]:[new AttachmentBuilder(resolve('tv/runtime/assets/standby.gif'),{name:'standby.gif'})]};
      if(old&&!this.bump){await old.edit({...payload,attachments:s.phase==='playing'?[]:[...old.attachments.values()].filter(a=>a.name==='standby.gif').map(a=>({id:a.id}))} as never);}
      else{
        // Send first so a failed send never destroys the only working controls.
        const sent=await ch.send(payload as never);s.message=sent.id;this.lastBump=Date.now();
        if(old)await old.delete().catch(()=>{});
        this.bump=false;
      }
      this.persist();
    }catch{log.warn('Streaming panel could not update. Check the VC chat permissions.');}
    finally{this.painting=false;}
  }
  onMessage(message:Message){
    if(!this.session||message.channelId!==this.session.channel||message.author.id===this.client?.user?.id)return;
    this.bump=true;
    if(!this.repaint)this.repaint=setTimeout(()=>{this.repaint=null;void this.paint()},Math.max(1500,5000-(Date.now()-this.lastBump)));
  }
  onDelete(id:string){if(this.session?.message===id){this.session.message=undefined;void this.paint()}}
  private voice(member:GuildMember):VoiceChannel{
    const ch=member.voice.channel;
    if(!ch||ch.type!==ChannelType.GuildVoice)throw new Error('Join a voice channel first.');
    const perms=ch.permissionsFor(member.guild.members.me!);
    if(!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles]))throw new Error('I need View Channel, Send Messages, Read History, and Attach Files in that VC.');
    return ch;
  }
  private async claim(member:GuildMember){
    const ch=this.voice(member);
    if(!getSettings(member.guild.id).modules.streaming)throw new Error('Streaming is turned off in Settings → Modules.');
    const current=this.session;
    if(current?.owner){
      if(current.guild!==member.guild.id||current.channel!==ch.id)throw new Error('TV is busy in another voice channel. Use My turn to join the queue.');
      if(current.owner!==member.id&&!isAdmin(member))throw new Error('Someone else has the controls. Use My turn to join the queue.');
      return;
    }
    getToken(member.guild.id); // Fail before reserving a session without credentials.
    if(current&&(current.channel!==ch.id||current.guild!==member.guild.id)){
      current.note='Session released. Use /stream in your VC.';await this.paint();
      this.session=null;
    }
    this.session??={id:randomBytes(6).toString('hex'),guild:member.guild.id,channel:ch.id,owner:null,episodes:[],episode:0,sources:[],source:'auto',lang:'dub',phase:'idle',position:0,duration:null,changed:Date.now(),note:''};
    this.session.owner=member.id;this.session.changed=Date.now();this.session.note='';this.session.phase='idle';
    this.emptyAt=0;this.absentAt=0;this.retries=0;this.persist();
  }
  private controller(member:GuildMember){
    const s=this.session;
    if(!s||!s.owner)throw new Error('This session is available. Use /stream to claim it.');
    if(s.guild!==member.guild.id||member.voice.channelId!==s.channel)throw new Error('Join the active voice channel to use these controls.');
    if(s.owner!==member.id&&!isAdmin(member))throw new Error('Only the controller or an admin can change playback. Use My turn.');
  }
  private async prepare(){
    const s=this.session!;
    await this.bridge.connect(s.guild,getToken(s.guild));
    this.streamerId=(await this.bridge.call<WorkerState>('/api/state')).streamerId;
  }
  private async load(title:Title){
    const s=this.session!;s.phase='loading';s.note='Checking episodes and sources…';s.changed=Date.now();await this.paint();
    await this.bridge.start();
    const data=await this.bridge.call('/api/episodes?'+new URLSearchParams({provider:title.provider,id:title.id}));
    s.title={...title,...data.selection,poster:title.poster||data.selection.poster};s.episodes=data.episodes;s.episode=0;
    s.sources=[...new Set<string>(data.sources.filter((x:any)=>x.status==='checked').map((x:any)=>x.provider))];
    await this.prepare();await this.bridge.call('/api/standby',{channel:s.channel});
    s.source='auto';s.actualSource=undefined;s.position=0;s.duration=null;s.phase='idle';s.note='Ready. Press Play.';this.persist();await this.paint();
  }
  private async play(position=0){
    const s=this.session!,ep=s.episodes[s.episode];
    if(!s.title||!ep)throw new Error('Choose an anime first.');
    s.phase='loading';s.note='Finding a working source…';s.position=position;s.changed=Date.now();await this.paint();
    await this.prepare();
    // Reuse cached title mappings; rebuild only after the TV service restarts.
    const path='/api/episodes?'+new URLSearchParams({provider:s.title.provider,id:s.title.id});
    let loaded:any;
    try{loaded=await this.bridge.call(path)}catch(error){
      if(!(error instanceof Error)||!error.message.includes('Search for this anime first'))throw error;
      const search=await this.bridge.call('/api/search?'+new URLSearchParams({q:s.title.title}));
      const match=search.results.find((r:Title)=>r.id===s.title!.id&&r.provider===s.title!.provider);
      if(!match)throw new Error('That title is unavailable right now. Use Find anime.');
      loaded=await this.bridge.call(path);
    }
    s.sources=[...new Set<string>(loaded.sources.filter((x:any)=>x.status==='checked').map((x:any)=>x.provider))];
    const chosen=loaded.episodes.find((e:any)=>e.number===ep.number);
    if(!chosen)throw new Error('That episode is not listed anymore. Choose another episode.');
    const result=await this.bridge.call('/api/play',{guild:s.guild,channel:s.channel,provider:s.title.provider,media:s.title.id,unit:chosen.id,lang:s.lang,subtitles:s.lang==='sub'?'en':'off',source:s.source,position});
    s.actualSource=result.provider;s.note='Starting video…';s.changed=Date.now();this.lastMotion=Date.now();this.lastPosition=position;this.persist();await this.paint();
  }
  private async release(note='Available. Use /stream to take a turn.'){
    const s=this.session;if(!s)return;
    // Stop cancels source verification; disconnect only after playback cleanup.
    await this.bridge.disconnect();
    s.owner=null;s.phase='idle';s.note=note;s.changed=Date.now();this.persist();await this.paint();
    while(this.queue.length){
      const next=this.queue.shift()!;
      const guild=this.client?.guilds.cache.get(next.guild);
      const member=await guild?.members.fetch(next.user).catch(()=>null);
      if(!member||member.voice.channelId!==next.channel||!getSettings(next.guild).modules.streaming)continue;
      try{await this.claim(member);this.session!.note='Your turn. Choose an anime or press Play.';await this.paint();break}catch{}
    }
  }
  private async fail(error:unknown){
    if(!this.session)return;
    this.session.phase='error';this.session.changed=Date.now();
    this.session.note=error instanceof Error?error.message.slice(0,300):'Playback failed. Try another source.';
    this.persist();await this.paint();
  }
  private async tick(){
    if(this.polling||this.closed)return;this.polling=true;
    try{
      const s=this.session;if(!s)return;
      for(const [key,v] of this.searchResults)if(v.expires<Date.now())this.searchResults.delete(key);
      if(!s.owner){if(this.bump)await this.paint();return}
      if(this.gate.locked)return;
      const ch=await this.channel();
      if(!ch||!getSettings(s.guild).modules.streaming){await this.gate.run(()=>this.release('Streaming stopped.'));return}
      const settings=getSettings(s.guild).streaming;
      const humans=ch.members.filter(m=>!m.user.bot&&m.id!==this.streamerId);
      this.emptyAt=humans.size?0:(this.emptyAt||Date.now());
      this.absentAt=humans.has(s.owner)?0:(this.absentAt||Date.now());
      if((this.emptyAt&&Date.now()-this.emptyAt>settings.emptySeconds*1000)||(this.absentAt&&Date.now()-this.absentAt>settings.idleSeconds*1000)||(['idle','paused','error','offline'].includes(s.phase)&&Date.now()-s.changed>settings.idleSeconds*1000)){
        await this.gate.run(()=>this.release());return;
      }
      if(['idle','error','offline'].includes(s.phase)){if(this.bump)await this.paint();return}
      const w=await this.bridge.call<WorkerState>('/api/state');this.streamerId=w.streamerId;
      if(w.status==='streaming'){
        s.phase='playing';s.position=w.position;s.duration=w.duration;s.note='';
        if(s.position>this.lastPosition){this.lastMotion=Date.now();this.lastPosition=s.position;this.retries=0;}
        else if(Date.now()-this.lastMotion>45000){await this.recover();return}
      }else if(w.status==='paused'){s.phase='paused';s.position=w.position;}
      else if(w.status==='ended'){
        if(settings.autoNext&&s.episode<s.episodes.length-1){await this.gate.run(async()=>{s.episode++;await this.play()});}
        else await this.gate.run(()=>this.release('Finished. TV is available.'));
        return;
      }else if(['offline','failed'].includes(w.status)){await this.recover();return}
      else if(s.phase==='loading'&&Date.now()-s.changed>45000){await this.recover();return}
      this.persist();await this.paint();
    }catch{if(this.session?.owner)await this.fail(new Error('Connection interrupted. Press Play to reconnect.'));}
    finally{this.polling=false}
  }
  private streamerId?:string;
  private async recover(){
    if(this.retries++>=2){await this.fail(new Error('Playback keeps failing. Choose another source or press Play.'));return}
    await this.gate.run(async()=>{const s=this.session!;s.source='auto';s.note='Reconnecting…';await this.play(s.position)});
  }
  async handle(i:Interaction):Promise<boolean>{
    const command=i.isChatInputCommand()&&i.commandName==='stream';
    const custom=('customId' in i)?i.customId:'';
    if(!command&&!custom.startsWith('tv:')&&!custom.startsWith('tvs:')&&!custom.startsWith('tvr:'))return false;
    if(!i.isRepliable())return true;
    const reply=async(content:string)=>{const payload={content,allowedMentions:NO_MENTIONS};if(i.deferred||i.replied)await i.editReply(payload);else await i.reply({...payload,flags:MessageFlags.Ephemeral})};
    try{
      if(!i.inCachedGuild()){await reply('Use this in the server.');return true}
      const member=i.member;
      if(custom.startsWith('tvs:')){await this.settings(i,member,custom.slice(4));return true}
      if(!getSettings(member.guild.id).modules.streaming)throw new Error('Streaming is turned off. Ask an admin to enable it in Settings → Modules.');
      if(command){
        await i.deferReply({flags:MessageFlags.Ephemeral});
        if(this.session?.owner&&(this.session.guild!==member.guild.id||this.session.owner!==member.id)){
          const ch=this.voice(member);
          await i.editReply({content:'TV is in use. Join the queue for a turn.',components:[new ActionRowBuilder<any>().addComponents((await import('../core/ui.js')).button('tvr:queue','My turn'))],allowedMentions:NO_MENTIONS});return true;
        }
        await this.gate.run(async()=>{await this.claim(member);await this.paint();if(!this.session!.title){await this.prepare();await this.bridge.call('/api/standby',{channel:this.session!.channel})}});await reply('Controls are in your voice channel chat.');return true;
      }
      if(custom==='tvr:queue'||custom.endsWith(':queue')){
        const ch=this.voice(member);
        const index=this.queue.findIndex(x=>x.user===member.id&&x.guild===member.guild.id);
        if(index>=0){this.queue.splice(index,1);await reply('Removed from the queue.');}
        else if(this.session?.owner===member.id&&this.session.guild===member.guild.id)await reply('You already have the controls.');
        else if(!this.session?.owner){await i.deferReply({flags:MessageFlags.Ephemeral});await this.gate.run(async()=>{await this.claim(member);await this.paint()});await reply('Your turn. Controls are in your VC chat.');}
        else{if(this.queue.length>=25)throw new Error('The queue is full. Try again later.');this.queue.push({guild:member.guild.id,user:member.id,channel:ch.id});await reply(`You are #${this.queue.length}. Stay in your VC. Press My turn again to leave the queue.`);}
        return true;
      }
      const parts=custom.split(':'),s=this.session;
      if(!s||parts[1]!==s.id||s.guild!==member.guild.id)throw new Error('That panel is from an old session. Use /stream for the current controls.');
      const op=parts[2];
      if(!s.owner&&['play','search'].includes(op||''))await this.gate.run(()=>this.claim(member));
      this.controller(member);
      if(i.isButton()&&['search','seek','episode'].includes(op||'')){
        const config=op==='search'?['Find anime','Anime name','Dr. STONE']:op==='seek'?['Jump to time',`${clock(s.position)} / ${s.duration?clock(s.duration):'unknown'}`,'12:30, 750, +90, or -30']:['Choose episode','Episode number',String(s.episodes[s.episode]?.number||1)];
        await i.showModal(inputModal(`tv:${s.id}:${op}Input`,config[0]!,config[1]!,config[2]!));return true;
      }
      await i.deferReply({flags:MessageFlags.Ephemeral});
      if((op==='stop'||op==='release')&&this.gate.locked){
        await this.bridge.call('/api/stop',{}).catch(()=>{});
        // Closing also cancels pending search/resolve requests in the child service.
        await this.bridge.close();
        for(let n=0;n<100&&this.gate.locked;n++)await sleep(100);
        if(this.gate.locked)throw new Error('Stopping. Wait a moment, then press Stop again.');
      }
      await this.gate.run(async()=>{
        s.changed=Date.now();
        if(i.isModalSubmit()&&op==='searchInput'){
          const q=i.fields.getTextInputValue('value').trim();if(q.length<2)throw new Error('Type at least two letters.');
          await this.bridge.start();const found=await this.bridge.call('/api/search?'+new URLSearchParams({q}));
          const seen=new Set<string>();
          const rows=(found.results as Title[]).filter(t=>{const key=t.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'');if(seen.has(key))return false;seen.add(key);return true}).slice(0,25);if(!rows.length)throw new Error('No results. Try another spelling.');
          const key=randomBytes(5).toString('hex');this.searchResults.set(key,{owner:member.id,session:s.id,rows,expires:Date.now()+600000});
          const select=new StringSelectMenuBuilder().setCustomId(`tv:${s.id}:pick:${key}`).setPlaceholder('Choose anime').addOptions(rows.map((t,n)=>({label:t.title.slice(0,100),description:t.provider,value:String(n)})));
          await i.editReply({content:'Choose a title.',components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],allowedMentions:NO_MENTIONS});return;
        }
        if(i.isStringSelectMenu()&&op==='pick'){
          const found=this.searchResults.get(parts[3]!);if(!found||found.owner!==member.id||found.expires<Date.now())throw new Error('Search expired. Use Find anime again.');
          const title=found.rows[Number(i.values[0])];if(!title)throw new Error('Choose a listed title.');
          await this.load(title);await reply('Ready. Press Play in the VC.');return;
        }
        if(op==='stop'||op==='release'){await this.release();await reply('TV released.');return}
        if(op==='next'||op==='prev'||op==='episodeInput'){
          const index=op==='episodeInput'&&i.isModalSubmit()?s.episodes.findIndex(e=>e.number===Number(i.fields.getTextInputValue('value'))):s.episode+(op==='next'?1:-1);
          if(index<0||index>=s.episodes.length)throw new Error('That episode is not available.');
          s.episode=index;this.retries=0;await this.play();
        }else if(['seekInput','back','forward'].includes(op||'')){
          const n=op==='seekInput'&&i.isModalSubmit()?seconds(i.fields.getTextInputValue('value'),s.position):Math.max(0,Math.min((s.duration||0)-1,s.position+(op==='back'?-30:30)));
          boundedPosition(n,s.duration);await this.bridge.call('/api/seek',{position:n});s.position=n;
        }else if(op==='source'&&i.isStringSelectMenu()){
          const source=i.values[0]!;if(source!=='auto'&&!s.sources.includes(source))throw new Error('That source is no longer available.');s.source=source;this.retries=0;await this.play(s.position);
        }else if(op==='lang'){s.lang=s.lang==='dub'?'sub':'dub';if(s.title)await this.play(s.position);}
        else if(op==='play'){
          this.retries=0;
          if(s.phase==='playing'){await this.bridge.call('/api/pause',{});s.phase='paused';}
          else if(s.phase==='paused'){await this.bridge.call('/api/resume',{});s.phase='loading';}
          else await this.play(s.position);
        }
        this.persist();await this.paint();await reply('Done.');
      });
    }catch(error){
      const message=error instanceof Error?error.message:'Something went wrong. Try again.';
      // Validation failures must not stop playback for everyone else.
      if(this.session?.phase==='loading'&&!this.gate.locked)await this.fail(error);
      try{await reply(message)}catch{}
    }
    return true;
  }
  private async settings(i:any,member:GuildMember,op:string){
    if(!isAdmin(member))throw new Error('Admins only.');
    if(i.isButton()&&op==='token'){await i.showModal(inputModal('tvs:token','Streaming account','Paste token · never shown after saving','Streaming account token'));return}
    if(i.isButton()&&op==='timers'){
      const s=getSettings(member.guild.id).streaming;
      await i.showModal(inputModal('tvs:timers','Idle and empty timeouts','Idle seconds, empty seconds (30–1800)','120, 60',`${s.idleSeconds}, ${s.emptySeconds}`));return;
    }
    await i.deferReply({flags:MessageFlags.Ephemeral});
    if(i.isModalSubmit()&&op==='token'){
      if(this.session?.owner)throw new Error('Release the active session before changing accounts.');
      saveToken(member.guild.id,i.fields.getTextInputValue('value'));await this.bridge.close();
    }else if(i.isModalSubmit()&&op==='timers'){
      const values=i.fields.getTextInputValue('value').split(',').map(Number);
      if(values.length!==2||values.some((n:number)=>!Number.isInteger(n)||n<30||n>1800))throw new Error('Enter two whole numbers from 30 to 1800.');
      setByPath(member.guild.id,'streaming.idleSeconds',values[0]);setByPath(member.guild.id,'streaming.emptySeconds',values[1]);
    }else if(op==='clear'){
      if(this.session?.owner)throw new Error('Release the active session first.');clearToken(member.guild.id);await this.bridge.close();
    }else if(op==='auto')setByPath(member.guild.id,'streaming.autoNext',!getSettings(member.guild.id).streaming.autoNext);
    await i.editReply({components:[settingsCard(member)],flags:V2_PUBLIC,allowedMentions:NO_MENTIONS});
  }
  async close(){this.closed=true;if(this.timer)clearInterval(this.timer);if(this.repaint)clearTimeout(this.repaint);await this.bridge.close();this.persist()}
}
export const streaming=new Streaming();
