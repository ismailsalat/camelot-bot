import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
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
  private paintTask:Promise<void>|null=null;
  private paintPending=false;
  private dirty=true;
  private paintError:Error|null=null;
  private bumpVersion=0;
  private stopping=false;
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
  private async paint(strict=false){
    this.paintPending=true;
    if(!this.paintTask){
      this.paintTask=this.flushPaint();
      try{await this.paintTask}finally{this.paintTask=null}
    }else await this.paintTask;
    if(strict&&this.paintError)throw this.paintError;
  }
  private async flushPaint(){
    while(this.paintPending&&this.session){
      this.paintPending=false;
      const s=this.session,version=this.bumpVersion;
      try{
        const ch=await this.channel();if(!ch)throw new Error('Voice channel unavailable.');
        let old=null;
        if(s.message){
          try{old=await ch.messages.fetch(s.message)}
          catch(error){if((error as {code?:number}).code!==10008)throw error;s.message=undefined}
        }
        const repost=this.bump&&Date.now()-this.lastBump>=5000;
        const payload={components:[panel(s,this.queue.length)],flags:V2_PUBLIC,allowedMentions:NO_MENTIONS,
          files:s.phase==='playing'||(old&&!repost&&old.attachments.some(a=>a.name==='standby.gif'))?[]:[new AttachmentBuilder(resolve('tv/runtime/assets/standby.gif'),{name:'standby.gif'})]};
        if(old&&!repost){await old.edit({...payload,attachments:s.phase==='playing'?[]:[...old.attachments.values()].filter(a=>a.name==='standby.gif').map(a=>({id:a.id}))} as never);}
        else{
          const sent=await ch.send(payload as never);s.message=sent.id;this.lastBump=Date.now();
          if(old)await old.delete().catch(()=>{});
          if(version===this.bumpVersion)this.bump=false;
        }
        if(this.session===s)this.persist();
        this.dirty=false;this.paintError=null;
      }catch{
        this.dirty=true;this.paintPending=false;
        this.paintError=new Error('Could not update the controls. Check Camelot’s VC chat permissions, then use /stream again.');
        log.warn(this.paintError.message);
      }
    }
  }
  onMessage(message:Message){
    if(!this.session||message.channelId!==this.session.channel||message.author.id===this.client?.user?.id)return;
    this.bump=true;this.bumpVersion++;
    if(!this.repaint)this.repaint=setTimeout(()=>{this.repaint=null;void this.paint()},Math.max(1500,5000-(Date.now()-this.lastBump)));
  }
  onDelete(id:string){if(this.session?.message===id){this.session.message=undefined;this.dirty=true;void this.paint()}}
  private voice(member:GuildMember):VoiceChannel{
    const ch=member.voice.channel;
    if(!ch||ch.type!==ChannelType.GuildVoice)throw new Error('Join a voice channel first.');
    const perms=ch.permissionsFor(member.guild.members.me!);
    if(!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles]))throw new Error('I need View Channel, Send Messages, Read History, and Attach Files in that VC.');
    return ch;
  }
  private async claim(member:GuildMember){
    const ch=this.voice(member);
    if(!getSettings(member.guild.id).modules.streaming)throw new Error('Streaming is turned off. An admin can turn it on in /settings → Streaming.');
    const current=this.session;
    if(current?.owner){
      if(current.guild!==member.guild.id||current.channel!==ch.id)throw new Error('Streaming is busy in another voice channel. Use My turn to join the queue.');
      if(current.owner!==member.id&&!isAdmin(member))throw new Error('Someone else has the controls. Use My turn to join the queue.');
      return;
    }
    getToken(member.guild.id); // Fail before reserving a session without credentials.
    if(current&&(current.channel!==ch.id||current.guild!==member.guild.id)){
      current.note='Session released. Use /stream in your VC.';await this.paint();
      this.session=null;
    }
    this.session??={id:randomBytes(6).toString('hex'),guild:member.guild.id,channel:ch.id,owner:null,episodes:[],episode:0,sources:[],source:'auto',lang:'dub',phase:'idle',position:0,duration:null,changed:Date.now(),note:''};
    this.session.id=randomBytes(6).toString('hex');this.session.owner=member.id;this.session.changed=Date.now();this.session.note='';this.session.phase='idle';
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
  private async playback(change:()=>Promise<void>){
    try{await change()}catch(error){if(!this.stopping&&!this.closed)await this.fail(error);throw error}
  }
  private async load(title:Title){await this.playback(()=>this.loadTitle(title))}
  private async loadTitle(title:Title){
    const s=this.session!;s.phase='loading';s.note='Checking episodes and sources…';s.changed=Date.now();await this.paint();
    await this.bridge.start();
    const data=await this.bridge.call('/api/episodes?'+new URLSearchParams({provider:title.provider,id:title.id}));
    s.title={...title,...data.selection,poster:title.poster||data.selection.poster};s.episodes=data.episodes;s.episode=0;
    s.sources=[...new Set<string>(data.sources.filter((x:any)=>x.status==='checked').map((x:any)=>x.provider))];
    await this.prepare();await this.bridge.call('/api/standby',{channel:s.channel});
    s.source='auto';s.actualSource=undefined;s.position=0;s.duration=null;s.phase='idle';s.note='Ready. Press Play.';this.persist();await this.paint();
  }
  private async play(position=0){await this.playback(()=>this.startEpisode(position))}
  private async startEpisode(position:number){
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
    if(!this.session||this.stopping||this.closed)return;
    await this.bridge.disconnect();
    this.session.phase='error';this.session.changed=Date.now();
    this.session.note='Could not play this episode. Try another source or press Play to reconnect.';
    log.warn('Streaming playback interrupted: '+(error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[source]').slice(0,300):'unknown error'));
    this.persist();await this.paint();
  }
  private async tick(){
    if(this.polling||this.closed||this.stopping||this.gate.locked)return;this.polling=true;
    try{
      await this.gate.run(async()=>{
        const s=this.session;if(!s)return;
        for(const [key,v] of this.searchResults)if(v.expires<Date.now())this.searchResults.delete(key);
        if(!s.owner){if(this.bump||this.dirty||!s.message)await this.paint();return}
        const ch=await this.channel();
        if(!ch||!getSettings(s.guild).modules.streaming){await this.release('Streaming stopped.');return}
        const settings=getSettings(s.guild).streaming;
        const humans=ch.members.filter(m=>!m.user.bot&&m.id!==this.streamerId);
        this.emptyAt=humans.size?0:(this.emptyAt||Date.now());
        this.absentAt=humans.has(s.owner)?0:(this.absentAt||Date.now());
        if((this.emptyAt&&Date.now()-this.emptyAt>settings.emptySeconds*1000)||(this.absentAt&&Date.now()-this.absentAt>settings.idleSeconds*1000)||(['idle','paused','error','offline'].includes(s.phase)&&Date.now()-s.changed>settings.idleSeconds*1000)){
          await this.release();return;
        }
        if(['idle','error','offline'].includes(s.phase)){if(this.bump||this.dirty||!s.message)await this.paint();return}
        const w=await this.bridge.call<WorkerState>('/api/state');this.streamerId=w.streamerId;
        if(w.status==='streaming'){
          s.phase='playing';s.position=w.position;s.duration=w.duration;s.note='';
          if(s.position>this.lastPosition){this.lastMotion=Date.now();this.lastPosition=s.position;if(Date.now()-s.changed>15000)this.retries=0;}
          else if(Date.now()-this.lastMotion>45000){await this.recoverLocked();return}
        }else if(w.status==='paused'){s.phase='paused';s.position=w.position;}
        else if(w.status==='ended'){
          if(settings.autoNext&&s.episode<s.episodes.length-1){s.episode++;s.duration=null;s.position=0;await this.play();}
          else await this.release('Finished. Streaming is available.');
          return;
        }else if(['offline','failed'].includes(w.status)){await this.recoverLocked();return}
        else if(s.phase==='loading'&&Date.now()-s.changed>45000){await this.recoverLocked();return}
        this.persist();await this.paint();
      });
    }catch{
      if(this.session?.owner&&!this.stopping&&!this.gate.locked&&this.session.phase!=='error'){
        try{await this.gate.run(()=>this.recoverLocked())}catch{}
      }
    }finally{this.polling=false}
  }
  private streamerId?:string;
  private async recoverLocked(){
    if(this.retries++>=2){await this.fail(new Error('Playback keeps failing. Choose another source or press Play.'));return}
    const s=this.session!;s.source='auto';s.note='Reconnecting…';await this.play(s.position);
  }
  async open(member:GuildMember){
    if(this.closed||this.stopping)throw new Error('Streaming is stopping. Try again in a moment.');
    if(!getSettings(member.guild.id).modules.streaming)throw new Error('Streaming is off. An admin can turn it on in /settings → Streaming.');
    this.voice(member);
    if(this.session?.owner&&(this.session.guild!==member.guild.id||this.session.owner!==member.id)){
      return {content:'Streaming is in use. Join the queue for a turn.',components:[new ActionRowBuilder<any>().addComponents((await import('../core/ui.js')).button('tvr:queue','My turn'))]};
    }
    await this.gate.run(async()=>{
      await this.claim(member);await this.paint(true);
      if(!this.session!.title){await this.prepare();await this.bridge.call('/api/standby',{channel:this.session!.channel})}
    });
    return {content:`Streaming controls are in <#${this.session!.channel}>.`,components:[]};
  }
  async handleText(message:Message<true>){
    if(message.author.bot||message.system||!message.member)return;
    const progress=await message.reply({content:'Opening Streaming controls…',allowedMentions:NO_MENTIONS});
    try{await progress.edit({...await this.open(message.member),allowedMentions:NO_MENTIONS})}
    catch(error){await progress.edit({content:error instanceof Error?error.message:'Could not open Streaming. Try again.',components:[],allowedMentions:NO_MENTIONS})}
  }
  async handle(i:Interaction):Promise<boolean>{
    const command=i.isChatInputCommand()&&i.commandName==='stream';
    const custom=('customId' in i)?i.customId:'';
    if(!command&&!custom.startsWith('tv:')&&!custom.startsWith('tvs:')&&!custom.startsWith('tvr:'))return false;
    if(!i.isRepliable())return true;
    const reply=async(content:string)=>{const payload={content,components:[],allowedMentions:NO_MENTIONS};if(i.deferred||i.replied)await i.editReply(payload);else await i.reply({...payload,flags:MessageFlags.Ephemeral})};
    try{
      if(!i.inCachedGuild()){await reply('Use this in the server.');return true}
      const member=i.member;
      if(this.closed||this.stopping)throw new Error('Streaming is stopping. Try again in a moment.');
      if(custom.startsWith('tvs:')){await this.settings(i,member,custom.slice(4));return true}
      if(!getSettings(member.guild.id).modules.streaming)throw new Error('Streaming is turned off. An admin can turn it on in /settings → Streaming.');
      if(command){
        await i.deferReply({flags:MessageFlags.Ephemeral});
        await i.editReply({...await this.open(member),allowedMentions:NO_MENTIONS});return true;
      }
      if(custom==='tvr:queue'||custom.endsWith(':queue')){
        const ch=this.voice(member);
        const index=this.queue.findIndex(x=>x.user===member.id&&x.guild===member.guild.id);
        if(index>=0){this.queue.splice(index,1);await reply('Removed from the queue.');}
        else if(this.session?.owner===member.id&&this.session.guild===member.guild.id)await reply('You already have the controls.');
        else if(!this.session?.owner){await i.deferReply({flags:MessageFlags.Ephemeral});await this.gate.run(async()=>{await this.claim(member);await this.paint(true)});await reply('Your turn. Controls are in your VC chat.');}
        else{if(this.queue.length>=25)throw new Error('The queue is full. Try again later.');this.queue.push({guild:member.guild.id,user:member.id,channel:ch.id});await reply(`You are #${this.queue.length}. Stay in your VC. Press My turn again to leave the queue.`);}
        return true;
      }
      const parts=custom.split(':'),s=this.session;
      if(!s||parts[1]!==s.id||s.guild!==member.guild.id)throw new Error('That panel is from an old session. Use /stream for the current controls.');
      const op=parts[2];
      if(!s.owner&&['play','search'].includes(op||'')){
        if(member.voice.channelId!==s.channel)throw new Error('Use /stream in your own voice channel.');
        await this.gate.run(()=>this.claim(member));
      }
      this.controller(member);
      if(i.isButton()&&['search','seek','episode'].includes(op||'')){
        const config=op==='search'?['Find anime','Anime name','Dr. STONE']:op==='seek'?['Jump to time',`${clock(s.position)} / ${s.duration?clock(s.duration):'unknown'}`,'12:30, 750, +90, or -30']:['Choose episode','Episode number',String(s.episodes[s.episode]?.number||1)];
        await i.showModal(inputModal(`tv:${s.id}:${op}Input`,config[0]!,config[1]!,config[2]!));return true;
      }
      await i.deferReply({flags:MessageFlags.Ephemeral});
      if(op==='stop'||op==='release'){
        if(this.session!==s)throw new Error('Session changed. Use /stream again.');
        this.controller(member);
        this.stopping=true;
        try{
          this.bridge.cancelRequests();await this.bridge.close();await this.gate.idle();
          await this.gate.run(()=>this.release());
          await reply('Streaming stopped. The next turn is available.');
        }finally{this.stopping=false}
        return true;
      }
      await this.gate.run(async()=>{
        if(this.session!==s)throw new Error('Session changed. Use /stream again.');
        this.controller(member);
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
          const found=this.searchResults.get(parts[3]!);if(!found||found.session!==s.id||found.owner!==member.id||found.expires<Date.now())throw new Error('Search expired. Use Find anime again.');
          const title=found.rows[Number(i.values[0])];if(!title)throw new Error('Choose a listed title.');
          await this.load(title);await reply('Ready. Press Play in the VC.');return;
        }
                if(op==='next'||op==='prev'||op==='episodeInput'){
          const index=op==='episodeInput'&&i.isModalSubmit()?s.episodes.findIndex(e=>e.number===Number(i.fields.getTextInputValue('value'))):s.episode+(op==='next'?1:-1);
          if(index<0||index>=s.episodes.length)throw new Error('That episode is not available.');
          s.episode=index;s.duration=null;s.position=0;this.retries=0;await this.play();
        }else if(['seekInput','back','forward'].includes(op||'')){
          if(!['playing','paused'].includes(s.phase))throw new Error('Press Play before changing the time.');
          const state=await this.bridge.call<WorkerState>('/api/state');
          if(!['streaming','paused'].includes(state.status))throw new Error('Playback is reconnecting. Try again in a moment.');
          s.position=state.position;s.duration=state.duration;
          const n=op==='seekInput'&&i.isModalSubmit()?seconds(i.fields.getTextInputValue('value'),s.position):Math.max(0,Math.min((s.duration||0)-1,s.position+(op==='back'?-30:30)));
          boundedPosition(n,s.duration);await this.playback(async()=>{await this.bridge.call('/api/seek',{position:n});s.position=n});
        }else if(op==='source'&&i.isStringSelectMenu()){
          const source=i.values[0]!;if(source!=='auto'&&!s.sources.includes(source))throw new Error('That source is no longer available.');s.source=source;this.retries=0;if(s.phase!=='idle')await this.play(s.position);
        }else if(op==='lang'){s.lang=s.lang==='dub'?'sub':'dub';if(s.title&&s.phase!=='idle')await this.play(s.position);}
        else if(op==='play'){
          this.retries=0;
          if(s.phase==='playing'){await this.playback(async()=>{await this.bridge.call('/api/pause',{});s.phase='paused';s.position=(await this.bridge.call<WorkerState>('/api/state')).position});}
          else if(s.phase==='paused'){await this.play(s.position);}
          else await this.play(s.position);
        }
        this.persist();await this.paint();await reply(s.phase==='paused'?'Paused.':s.phase==='loading'?`Starting episode ${s.episodes[s.episode]?.number}…`:['seekInput','back','forward'].includes(op||'')?`Time set to ${clock(s.position)} / ${clock(s.duration||0)}.`:'Streaming controls updated.');
      });
    }catch(error){
      const message=error instanceof Error?error.message:'Something went wrong. Try again.';
      // Validation failures must not stop playback for everyone else.
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
    if(op==='toggle'){setByPath(member.guild.id,'modules.streaming',!getSettings(member.guild.id).modules.streaming);await i.editReply({components:[settingsCard(member)],flags:V2_PUBLIC,allowedMentions:NO_MENTIONS});return}
    if(op==='check'){
      if(this.session?.owner)throw new Error('Stop the active stream before checking the account.');
      await this.gate.run(async()=>{try{await this.bridge.connect(member.guild.id,getToken(member.guild.id))}finally{await this.bridge.close()}});
      await i.editReply({content:'Streaming account connected successfully. Join a VC and use /stream.',allowedMentions:NO_MENTIONS});return;
    }
    if(i.isModalSubmit()&&op==='token'){
      if(this.session?.owner)throw new Error('Release the active session before changing accounts.');
      await this.gate.run(async()=>{saveToken(member.guild.id,i.fields.getTextInputValue('value'));await this.bridge.close()});
    }else if(i.isModalSubmit()&&op==='timers'){
      const values=i.fields.getTextInputValue('value').split(',').map(Number);
      if(values.length!==2||values.some((n:number)=>!Number.isInteger(n)||n<30||n>1800))throw new Error('Enter two whole numbers from 30 to 1800.');
      setByPath(member.guild.id,'streaming.idleSeconds',values[0]);setByPath(member.guild.id,'streaming.emptySeconds',values[1]);
    }else if(op==='clear'){
      if(this.session?.owner)throw new Error('Release the active session first.');await this.gate.run(async()=>{clearToken(member.guild.id);await this.bridge.close()});
    }else if(op==='auto')setByPath(member.guild.id,'streaming.autoNext',!getSettings(member.guild.id).streaming.autoNext);
    await i.editReply({components:[settingsCard(member)],flags:V2_PUBLIC,allowedMentions:NO_MENTIONS});
  }
  async close(){this.closed=true;this.stopping=true;this.bridge.cancelRequests();if(this.timer)clearInterval(this.timer);if(this.repaint)clearTimeout(this.repaint);await this.bridge.close();this.persist()}
}
export const streaming=new Streaming();
