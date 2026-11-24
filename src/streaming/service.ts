import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {ActionRowBuilder,AttachmentBuilder,ChannelType,MessageFlags,escapeMarkdown,PermissionFlagsBits,StringSelectMenuBuilder,type Client,type GuildMember,type Interaction,type Message,type VoiceChannel} from 'discord.js';
import {getSettings,setByPath} from '../db/settings.js';
import {isAdmin} from '../core/permissions.js';
import {NO_MENTIONS} from '../util/mentions.js';
import {V2_FLAGS,V2_PUBLIC} from '../core/ui.js';
import {log} from '../logger.js';
import {Bridge,type WorkerState} from './bridge.js';
import {botTimeline} from './timeline.js';
import {addToQueue,hasPanelControls,queueView,removeFromQueue,takeNext} from './queue.js';
import {Gate,boundedPosition,clock,seconds,type Session,type Title} from './model.js';
import {withFamily} from './seasons.js';
import {parseEpisodeInput} from './episodes.js';
import {StallWatch} from './stall.js';
import {clearToken,getToken,restoreSession,saveSession,saveToken} from './store.js';
import {inputModal,panel,settingsCard} from './ui.js';

/** How long the stream is watched before judging whether it froze (the poll runs every few seconds). */
const STALL_WINDOW_MS=12000;
type Waiter={guild:string;user:string;channel:string};
/** Buttons and menus that live on the main panel; only the newest panel message may use them. */
const PANEL_OPS=new Set(['prev','next','stop','play','seek','goep','skipb','skipf','skipop','epsel','season','quality','search','lang','lineup','source']);
/** Queue actions anyone in the voice channel may use (removing and clearing still need the controller). */
const SHARED_OPS=new Set(['lineup','qadd','qaddInput','qpick']);
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
  /** Playback progress check: the stream counts as frozen when it advances much slower than real time. */
  private watch=new StallWatch(STALL_WINDOW_MS);
  private stalls=0;
  private avoid:string[]=[];
  private closed=false;
  private forceRepost=false;
  private rejoinWanted=false;
  private rejoinAt:number|null=null;
  private lastRejoin=0;
  private autoToken=0;
  private lastStatusLog=0;
  /** Milliseconds per countdown step (tests set 0). */
  countdownMs=1000;
  private searchResults=new Map<string,{owner:string;session:string;rows:Title[];all:Title[];expires:number}>();
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
  /** One line per phase change with what the worker was doing at that moment, so "panel says loading, worker says streaming" is visible. */
  private lastWorkerStatus='unknown';
  private noteTransition(s:Session){
    if(s.phase===this.loggedPhase)return;
    const from=this.loggedPhase||'-';this.loggedPhase=s.phase;
    botTimeline.mark('phase_'+s.phase,{cid:this.cid,from,worker:this.lastWorkerStatus});
    log.info(`[stream] phase ${from} -> ${s.phase} worker=${this.lastWorkerStatus} cid=${this.cid??'-'} episode=${s.episodes[s.episode]?.number??'-'} note=${(s.note||'').replace(/https?:\/\/\S+/g,'[link]').slice(0,80)}`);
  }
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
      this.noteTransition(s);
      try{
        const ch=await this.channel();if(!ch)throw new Error('Voice channel unavailable.');
        let old=null;
        if(s.message){
          try{old=await ch.messages.fetch(s.message)}
          catch(error){if((error as {code?:number}).code!==10008)throw error;s.message=undefined}
        }
        const forced=this.forceRepost;
        const repost=forced||(this.bump&&Date.now()-this.lastBump>=5000);
        const payload={components:[panel(s,this.queue.length)],flags:V2_PUBLIC,allowedMentions:NO_MENTIONS,
          files:s.phase==='playing'||(old&&!repost&&old.attachments.some(a=>a.name==='standby.gif'))?[]:[new AttachmentBuilder(resolve('tv/runtime/assets/standby.gif'),{name:'standby.gif'})]};
        if(old&&!repost){await old.edit({...payload,attachments:s.phase==='playing'?[]:[...old.attachments.values()].filter(a=>a.name==='standby.gif').map(a=>({id:a.id}))} as never);}
        else{
          const sent=await ch.send(payload as never);s.message=sent.id;this.lastBump=Date.now();
          if(old)await old.delete().catch(()=>{});
          if(forced||!old)await this.sweep(ch,sent.id);
          this.forceRepost=false;
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
  /** Delete any other Camelot panel left in the channel so only the newest one can ever be pressed. */
  private async sweep(ch:VoiceChannel,keep:string){
    try{
      const recent=await ch.messages.fetch({limit:40});
      for(const m of recent.values()){
        if(m.id===keep||m.author?.id!==this.client?.user?.id||!hasPanelControls(m.components as never))continue;
        await m.delete().catch(()=>{});
      }
    }catch{}
  }
  /** Remove a panel from a channel the session has left. */
  private async retire(s:Session){
    if(!s.message||!this.client)return;
    const ch:any=await this.client.channels.fetch(s.channel).catch(()=>null);
    await ch?.messages?.delete?.(s.message).catch(()=>{});
    s.message=undefined;
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
      await this.retire(current);
      this.session=null;
    }
    this.session??={id:randomBytes(6).toString('hex'),guild:member.guild.id,channel:ch.id,owner:null,episodes:[],episode:0,sources:[],source:'auto',lang:'dub',phase:'idle',position:0,duration:null,changed:Date.now(),note:''};
    this.session.id=randomBytes(6).toString('hex');this.session.owner=member.id;this.session.changed=Date.now();this.session.note='';this.session.phase='idle';
    this.emptyAt=0;this.absentAt=0;this.retries=0;this.rejoinWanted=false;this.rejoinAt=null;this.autoToken++;this.persist();
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
  /** Episode list for a title; re-searches once if the TV service restarted and forgot it. */
  private async episodesFor(title:{provider:string;id:string;title:string}):Promise<any>{
    const path='/api/episodes?'+new URLSearchParams({provider:title.provider,id:title.id});
    try{return await this.bridge.call(path)}catch(error){
      if(!(error instanceof Error)||!error.message.includes('Search for this anime first'))throw error;
      const search=await this.bridge.call('/api/search?'+new URLSearchParams({q:title.title}));
      const match=search.results.find((r:Title)=>r.id===title.id&&r.provider===title.provider);
      if(!match)throw new Error('That title is unavailable right now. Use Find anime.');
      return this.bridge.call(path);
    }
  }
  private async load(title:Title){await this.playback(()=>this.loadTitle(title))}
  private async loadTitle(title:Title){
    const s=this.session!;s.phase='loading';s.note='Checking episodes and sources…';s.changed=Date.now();await this.paint();
    await this.bridge.start();
    // Log the streaming account in first (usually already warm), then look up episodes while the standby
    // Go Live window opens, so the two waits overlap instead of adding up.
    await this.prepare();
    const [data]=await Promise.all([this.episodesFor(title),this.bridge.call('/api/standby',{channel:s.channel})]);
    s.title={...title,...data.selection,poster:title.poster||data.selection.poster};s.episodes=data.episodes;s.episode=0;
    s.sources=[...new Set<string>(data.sources.filter((x:any)=>x.status==='checked'&&x.accepted!==false).map((x:any)=>x.provider))];
    s.source='auto';s.actualSource=undefined;s.hd=false;s.quality='720p';s.epPage=undefined;s.position=0;s.duration=null;s.phase='idle';s.note='Ready. Press Play.';this.persist();await this.paint();
  }
  private async play(position=0,initiator:'user'|'auto'|'recovery'|'queue'='user'){this.initiator=initiator;try{await this.playback(()=>this.startEpisode(position))}finally{this.initiator='user'}}
  private async startEpisode(position:number){
    const s=this.session!,ep=s.episodes[s.episode];
    if(!s.title||!ep)throw new Error('Choose an anime first.');
    if(this.initiator!=='recovery')this.stalls=0;
    this.watch.reset();
    s.phase='loading';s.note='Finding a working source…';s.position=position;s.changed=Date.now();await this.paint();
    botTimeline.mark('panel_loading_painted',{cid:this.cid});
    await this.prepare();
    // The episode list was loaded when the anime was picked, so play it straight away; asking the TV
    // service for it again re-inspected every source (~4 s). A restarted service is handled by the retry below.
    const cid=`${s.id.slice(0,4)}-${++this.playCounter}`;this.cid=cid;
    botTimeline.mark('play_requested',{cid,episode:ep.number,lang:s.lang,source:s.source,quality:s.quality||'720p',initiated_by:this.initiator});
    const playRequest={cid,initiatedBy:this.initiator,guild:s.guild,channel:s.channel,provider:s.title.provider,media:s.title.id,unit:ep.id,lang:s.lang,subtitles:s.lang==='sub'?'en':'off',source:s.source,quality:s.quality||'720p',position,avoid:this.avoid};this.avoid=[];
    let result:any;
    try{result=await this.bridge.call('/api/play',playRequest)}
    catch(error){
      // If the streaming process itself died mid-start, every source then reports "not connected".
      // That is not the episode's fault: reconnect the account once and try again.
      if(!(error instanceof Error)||!/Streaming account disconnected|Streamer is not connected|Choose an anime and episode from search results first/.test(error.message))throw error;
      log.warn('Streaming worker stopped while starting playback; reconnecting once. ('+error.message.slice(0,80)+')');
      s.note='Reconnecting the streaming account…';await this.paint();
      await this.prepare();
      // Reconnecting restarts the TV service, which forgets the search it had cached; load the title again.
      const loaded=await this.episodesFor(s.title);
      const chosen=loaded.episodes.find((e:any)=>e.number===ep.number);
      if(!chosen)throw new Error('That episode is not listed anymore. Choose another episode.');
      result=await this.bridge.call('/api/play',{...playRequest,unit:chosen.id});
    }
    botTimeline.mark('play_acked',{cid,provider:result.provider,quality:result.streamQuality});
    s.actualSource=result.provider;s.subtitle=result.subtitle?.mode==='burned'?'EN subtitles':s.lang==='sub'?'no subtitles':'';s.hd=!!result.hd;s.quality=result.streamQuality==='1080p'?'1080p':'720p';s.note='Starting video…';s.changed=Date.now();this.lastMotion=Date.now();this.lastPosition=position;this.persist();await this.paint();
    this.followUp();
  }
  private async release(note='Available. Use /stream to take a turn.'){
    const s=this.session;if(!s)return;
    // Stop cancels source verification; disconnect only after playback cleanup.
    await this.bridge.disconnect();
    s.owner=null;s.phase='idle';s.note=note;s.changed=Date.now();s.queue=[];this.rejoinWanted=false;this.rejoinAt=null;this.autoToken++;this.persist();await this.paint();
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
    const detail=this.bridge.running?await this.bridge.call<WorkerState>('/api/state').catch(()=>null):null;
    await this.bridge.disconnect();
    const why=error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[source]').replace(/\s+/g,' ').slice(0,300):'unknown error';
    this.session.phase='error';this.session.changed=Date.now();
    this.session.note='Could not play this episode. Try another source or press Play to reconnect.'+(why&&why!=='unknown error'?`\nReason: ${why.slice(0,140)}`:'');
    log.warn(`Streaming playback interrupted: ${why} | worker=${detail?.status??'unreachable'} lastError=${(detail?.lastError||'-').slice(0,200)} safeMode=${detail?.safeMode??'-'} episode=${this.session.episodes[this.session.episode]?.number??'-'} source=${this.session.source}`);
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
        if(['idle','error','offline'].includes(s.phase)){
          // Kicked while waiting on the standby screen: come back too.
          if(s.phase==='idle'&&!this.rejoinWanted&&this.bridge.running){
            const peek=await this.bridge.call<WorkerState>('/api/state').catch(()=>null);
            if(peek?.status==='failed'&&peek.failReason==='kicked')this.markKicked(null);
          }
          if(this.rejoinWanted){await this.rejoin(s);return}
          if(this.bump||this.dirty||!s.message)await this.paint();return;
        }
        const w=await this.bridge.call<WorkerState>('/api/state');this.streamerId=w.streamerId;
        if(w.status!==this.lastWorkerStatus){log.info(`[stream] worker ${this.lastWorkerStatus} -> ${w.status}${w.failReason?` (${w.failReason})`:''} phase=${s.phase} cid=${this.cid??'-'}`);this.lastWorkerStatus=w.status}
        if(s.phase==='loading'&&w.status==='streaming')log.info(`[stream] worker is streaming while the panel still says loading (changing to playing) cid=${this.cid??'-'}`);
        if(Date.now()-this.lastStatusLog>=30000){
          this.lastStatusLog=Date.now();
          log.info(`[stream] phase=${s.phase} worker=${w.status} episode=${s.episodes[s.episode]?.number??'-'} position=${Math.round(w.position||0)}s source=${s.actualSource||'-'} retries=${this.retries} queue=${s.queue?.length??0} rejoin=${this.rejoinWanted} safeMode=${w.safeMode??false}${w.failReason?` failReason=${w.failReason}`:''}`);
        }
        if(w.status==='failed'&&w.failReason==='kicked'&&!this.rejoinWanted)this.markKicked(['playing','paused','loading'].includes(s.phase)?Math.max(s.position,w.position||0):null);
        if(this.rejoinWanted){await this.rejoin(s);return}
        if(w.status==='streaming'){
          s.phase='playing';s.position=w.position;s.duration=w.duration;s.note='';
          // A source that stops delivering leaves the stream "playing" at under 1 fps while the position creeps forward,
          // so "position increased" is not enough. Compare how far the video advanced with how much time passed.
          const verdict=this.watch.check(s.position,Date.now(),Date.now()-s.changed);
          if(verdict&&!verdict.healthy){await this.stallFailover(s,verdict.advanced,verdict.elapsed);return}
          if(verdict?.healthy)this.stalls=0;
          if(s.position>this.lastPosition){this.lastMotion=Date.now();this.lastPosition=s.position;if(Date.now()-s.changed>15000)this.retries=0;}
          else if(Date.now()-this.lastMotion>60000){await this.recoverLocked();return}
        }else if(w.status==='paused'){this.watch.reset();s.phase='paused';s.position=w.position;}
        else if(w.status==='ended'){
          if(s.episode>=s.episodes.length-1&&await this.advanceQueue(s))return;
          if(settings.autoNext&&s.episode<s.episodes.length-1){s.episode++;s.duration=null;s.position=0;await this.play(0,'auto');}
          else await this.release('Finished. Streaming is available.');
          return;
        }else if(['offline','failed'].includes(w.status)){await this.recoverLocked();return}
        else if(s.phase==='loading'&&Date.now()-s.changed>90000){await this.recoverLocked();return}
        this.persist();await this.paint();
      });
    }catch{
      if(this.session?.owner&&!this.stopping&&!this.gate.locked&&this.session.phase!=='error'){
        try{await this.gate.run(()=>this.recoverLocked())}catch{}
      }
    }finally{this.polling=false}
  }
  private streamerId?:string;
  private playCounter=0;
  private cid:string|undefined;
  private initiator:'user'|'auto'|'recovery'|'queue'='user';
  private loggedPhase='';
  private followUps=0;
  /** After a play request the worker needs a few seconds to show its first frame; poll every second until the panel
   *  can say "playing", instead of waiting for the regular 5 s tick. Bounded to 25 checks per play. */
  private followUp(){
    this.followUps=25;
    const step=()=>{
      const s=this.session;
      if(this.closed||this.stopping||!s||s.phase!=='loading'||this.followUps--<=0)return;
      void this.tick().finally(()=>{const t=setTimeout(step,1000);t.unref()});
    };
    const t=setTimeout(step,1000);t.unref();
  }
  private markKicked(resumeAt:number|null){
    this.rejoinWanted=true;this.rejoinAt=resumeAt;this.lastRejoin=0;
    log.warn('Camelot was removed from the voice channel; rejoining until Stop is pressed.');
  }
  /** Come back after being kicked or disconnected. Tries every 10 s until it works or someone presses Stop. */
  private async rejoin(s:Session){
    if(Date.now()-this.lastRejoin<10000)return;
    this.lastRejoin=Date.now();s.changed=Date.now();
    const at=this.rejoinAt;
    s.note='Camelot was removed from the voice channel. Coming back…';
    try{
      if(at!==null&&s.title&&s.episodes[s.episode]){s.phase='loading';await this.paint();this.initiator='recovery';try{await this.startEpisode(at)}finally{this.initiator='user'}}
      else{
        await this.paint();await this.prepare();await this.bridge.call('/api/standby',{channel:s.channel});
        s.note=s.title?'Ready. Press Play.':'';
      }
      this.rejoinWanted=false;this.rejoinAt=null;this.retries=0;
    }catch(error){
      if(this.stopping||this.closed||this.session!==s)return;
      log.warn('Could not rejoin yet: '+(error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[source]').slice(0,200):'unknown'));
      s.note='Could not rejoin yet. Trying again in a few seconds… Press Stop to end this.';
    }
    this.persist();await this.paint();
  }
  /** Move on to the next queued anime; anything that no longer loads is skipped. */
  private async advanceQueue(s:Session):Promise<boolean>{
    let next:Title|null;
    while((next=takeNext(s))){
      try{await this.loadTitle(next);this.scheduleAutoStart(s);return true}
      catch(error){
        if(this.stopping||this.closed||this.session!==s)return false;
        log.warn('Skipped a queued anime: '+(error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[source]').slice(0,160):'unknown'));
        s.phase='idle';s.note=`Skipped ${next.title.slice(0,60)}: it is unavailable right now.`;
      }
    }
    return false;
  }
  /** Count 5-4-3-2-1 in the VC chat, then start episode 1 on its own unless someone steps in. */
  scheduleAutoStart(s:Session){
    const token=++this.autoToken;
    setTimeout(()=>{void this.countdown(s,token)},0);
  }
  private async countdown(s:Session,token:number){
    const valid=()=>this.autoToken===token&&this.session===s&&!!s.owner&&s.phase==='idle'&&!!s.title&&!this.closed&&!this.stopping;
    if(!valid())return;
    let msg:Message|null=null;
    try{
      const ch=await this.channel();
      const name=escapeMarkdown((s.title?.title||'').slice(0,60));
      for(let n=5;n>=1;n--){
        if(!valid())break;
        const content=`**Camelot** · ${name} starts in **${n}**`;
        try{if(ch){if(msg)await msg.edit({content,allowedMentions:NO_MENTIONS});else msg=await ch.send({content,allowedMentions:NO_MENTIONS})}}catch{}
        if(this.countdownMs)await new Promise(r=>setTimeout(r,this.countdownMs));
      }
      await msg?.delete().catch(()=>{});msg=null;
      if(!valid())return;
      // A background poll may hold the gate for a moment; wait for it rather than dropping the start.
      for(let attempt=0;attempt<10&&valid();attempt++){
        await this.gate.idle();
        try{await this.gate.run(async()=>{if(valid()){this.retries=0;await this.play(0,'auto')}});return}
        catch(error){if(!(error instanceof Error)||!error.message.startsWith('One moment'))throw error}
      }
    }catch(error){
      await msg?.delete().catch(()=>{});
      log.warn('Auto-start did not run: '+(error instanceof Error?error.message.slice(0,160):'unknown'));
    }
  }
  /** The video froze (the source stopped sending data). Move to another source at the same spot instead of waiting for a person to notice. */
  private async stallFailover(s:Session,advanced:number,elapsed:number){
    this.watch.reset();
    const bad=s.actualSource;
    botTimeline.mark('stall_detected',{cid:this.cid,provider:bad,position:Math.round(s.position),advanced_s:Math.round(advanced*10)/10,over_s:Math.round(elapsed)});
    if(this.stalls++>=3){this.stalls=0;await this.fail(new Error('The video keeps freezing on every source. Try again in a minute, or pick another episode.'));return}
    log.warn(`[stream] video froze: advanced ${advanced.toFixed(1)}s in ${Math.round(elapsed)}s on ${bad||'?'} at ${Math.round(s.position)}s; switching source (attempt ${this.stalls}/3)`);
    this.avoid=bad?[bad]:[];
    s.source='auto';s.note=`Video froze on ${bad||'the source'}. Switching to another source…`;
    await this.play(s.position,'recovery');
  }
  private async recoverLocked(){
    if(this.retries++>=2){await this.fail(new Error('Playback keeps failing. Choose another source or press Play.'));return}
    const s=this.session!;s.source='auto';s.note='Reconnecting…';await this.play(s.position,'recovery');
  }
  async open(member:GuildMember){
    if(this.closed||this.stopping)throw new Error('Streaming is stopping. Try again in a moment.');
    if(!getSettings(member.guild.id).modules.streaming)throw new Error('Streaming is off. An admin can turn it on in /settings → Streaming.');
    this.voice(member);
    if(this.session?.owner&&(this.session.guild!==member.guild.id||this.session.owner!==member.id)){
      return {content:'Streaming is in use. Join the queue for a turn.',components:[new ActionRowBuilder<any>().addComponents((await import('../core/ui.js')).button('tvr:queue','My turn'))]};
    }
    await this.gate.run(async()=>{await this.claim(member);this.forceRepost=true;await this.paint(true)});
    // Logging the streaming account in takes ~7 s. Do it while the person picks an anime instead of
    // making them wait on /stream; later steps join the same connection attempt.
    this.warm();
    return {content:`Streaming controls are in <#${this.session!.channel}>.`,components:[]};
  }
  warming:Promise<void>|null=null;
  /** Log the streaming account in while the person picks an anime. Not gated, so searching never has to wait. */
  private warm(){
    const s=this.session;if(!s||s.title||this.warming)return;
    const still=()=>this.session===s&&!s.title&&s.phase==='idle'&&!this.closed&&!this.stopping;
    this.warming=(async()=>{
      await this.prepare();
      if(!still())return;
      await this.bridge.call('/api/standby',{channel:s.channel});
    })().catch(async(error:unknown)=>{
      if(this.session!==s||this.closed||this.stopping||s.title)return;
      log.warn('Streaming account could not be warmed up: '+(error instanceof Error?error.message:'unknown').slice(0,200));
      s.phase='error';s.changed=Date.now();s.note=error instanceof Error?error.message:'Could not connect the streaming account.';this.persist();await this.paint().catch(()=>{});
    }).finally(()=>{this.warming=null});
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
    const received=botTimeline.mark('interaction_received',{cid:this.cid,kind:command?'command':custom.split(':')[2]||custom,age_ms:Math.max(0,Date.now()-i.createdTimestamp)});
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
      // Only the newest panel works. Anything older is removed and rejected.
      if((i.isButton()||i.isStringSelectMenu())&&PANEL_OPS.has(op||'')&&s.message&&i.message?.id&&i.message.id!==s.message){
        await i.message.delete().catch(()=>{});
        throw new Error('That panel is out of date and was removed. Use the newest controls at the bottom of the chat, or /stream.');
      }
      if(SHARED_OPS.has(op||'')){
        if(!s.owner)throw new Error('Start Streaming with /stream first.');
        if(s.guild!==member.guild.id||member.voice.channelId!==s.channel)throw new Error('Join the active voice channel to use the queue.');
      }else this.controller(member);
      if(i.isButton()&&['search','seek','qadd','goep'].includes(op||'')){
        const nums=s.episodes.map(e=>e.number);
        if(op==='goep'&&!nums.length)throw new Error('Choose an anime first.');
        const config=op==='goep'?['Go to episode',`Episode ${Math.min(...nums)}–${Math.max(...nums)} (now ${s.episodes[s.episode]?.number??'-'})`,'206, e206, +5, -3 or last']:op==='search'?['Find anime','Anime name','Dr. STONE']:op==='qadd'?['Add to queue','Anime name','Dr. STONE']:['Jump to time',`Now ${clock(s.position)} of ${s.duration?clock(s.duration):'unknown'}`,'12:30, 750, +90, or -30'];
        await i.showModal(inputModal(`tv:${s.id}:${op}Input`,config[0]!,config[1]!,config[2]!));return true;
      }
      if((i.isButton()||i.isStringSelectMenu())&&['qskip','qclear','qdel','qpick'].includes(op||''))await i.deferUpdate();
      else await i.deferReply({flags:MessageFlags.Ephemeral});
      botTimeline.mark('interaction_acked',{cid:this.cid,kind:op});
      if(op==='stop'||op==='release'){
        this.autoToken++;
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
        if(SHARED_OPS.has(op||'')){if(!s.owner||member.voice.channelId!==s.channel)throw new Error('Join the active voice channel to use the queue.')}
        else this.controller(member);
        s.changed=Date.now();
        if(['play','prev','next','episodeInput','goepInput','epsel','season','pick','qskip'].includes(op||''))this.autoToken++;
        const showQueue=async(note='')=>{this.persist();await this.paint();await i.editReply({...queueView(s,note),allowedMentions:NO_MENTIONS})};
        if(op==='lineup'){await showQueue();return}
        if(op==='qclear'){s.queue=[];await showQueue('Queue cleared.');return}
        if(op==='qdel'&&i.isStringSelectMenu()){const gone=removeFromQueue(s,Number(i.values[0]));await showQueue(gone?`Removed ${gone.title.slice(0,60)}.`:'That one is already gone.');return}
        if(op==='qskip'){
          if(!(s.queue?.length))throw new Error('The queue is empty.');
          if(!await this.advanceQueue(s))throw new Error('Nothing in the queue could be loaded right now.');
          await showQueue('Loaded the next anime. It starts in 5 seconds.');return;
        }
        if(i.isModalSubmit()&&(op==='searchInput'||op==='qaddInput')){
          const q=i.fields.getTextInputValue('value').trim();if(q.length<2)throw new Error('Type at least two letters.');
          await this.bridge.start();const found=await this.bridge.call('/api/search?'+new URLSearchParams({q}));
          const seen=new Set<string>();
          const all=(found.results as any[]).map(t=>({...t,count:t.count??t.numberOfEpisodes})) as Title[];
          // The TV service returns one row per real anime, already ordered (TV first, then movies and specials). Only drop exact repeats of the same anime.
          const rows=all.filter(t=>{const key=t.entity||`${t.provider}:${t.id}`;if(seen.has(key))return false;seen.add(key);return true}).slice(0,25);if(!rows.length)throw new Error('No results. Try another spelling.');
          const key=randomBytes(5).toString('hex');this.searchResults.set(key,{owner:member.id,session:s.id,rows,all,expires:Date.now()+600000});
          const select=new StringSelectMenuBuilder().setCustomId(`tv:${s.id}:${op==='qaddInput'?'qpick':'pick'}:${key}`).setPlaceholder('Choose anime').addOptions(rows.map((t,n)=>({label:t.title.slice(0,100),description:(t.description||t.provider).slice(0,100),value:String(n)})));
          await i.editReply({content:'Choose a title.',components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],allowedMentions:NO_MENTIONS});return;
        }
        if(i.isStringSelectMenu()&&op==='qpick'){
          const found=this.searchResults.get(parts[3]!);if(!found||found.session!==s.id||found.owner!==member.id||found.expires<Date.now())throw new Error('Search expired. Use Add anime again.');
          const title=found.rows[Number(i.values[0])];if(!title)throw new Error('Choose a listed title.');
          const result=addToQueue(s,withFamily(title,found.rows,found.all));
          await showQueue(result==='added'?`Added ${title.title.slice(0,60)}.`:result==='duplicate'?'That anime is already playing or queued.':'The queue is full.');return;
        }
        if(i.isStringSelectMenu()&&op==='pick'){
          const found=this.searchResults.get(parts[3]!);if(!found||found.session!==s.id||found.owner!==member.id||found.expires<Date.now())throw new Error('Search expired. Use Find anime again.');
          const title=found.rows[Number(i.values[0])];if(!title)throw new Error('Choose a listed title.');
          await this.load(withFamily(title,found.rows,found.all));this.scheduleAutoStart(s);await reply('Starting automatically. Camelot counts down 5-4-3-2-1 in the VC chat. Press Stop to cancel.');return;
        }
                if(op==='next'||op==='prev'||op==='episodeInput'||op==='goepInput'){
          // Typed episode numbers are checked first so the person is told what exists ("the last episode is 291") instead of nothing happening.
          const typed=(op==='episodeInput'||op==='goepInput')&&i.isModalSubmit();
          const index=typed?parseEpisodeInput(i.fields.getTextInputValue('value'),s.episodes,s.episode):s.episode+(op==='next'?1:-1);
          if(index<0||index>=s.episodes.length)throw new Error(op==='next'?'That was the last episode.':'That is the first episode.');
          if(typed&&index===s.episode&&['playing','paused'].includes(s.phase))throw new Error(`Episode ${s.episodes[index]!.number} is already playing.`);
          s.episode=index;s.duration=null;s.position=0;this.retries=0;this.stalls=0;await this.play();
        }else if(op==='epsel'&&i.isStringSelectMenu()){
          const value=i.values[0]!;
          if(value.startsWith('page:')){s.epPage=Math.max(0,Number(value.slice(5))||0);this.persist();await this.paint();return await i.deleteReply().catch(()=>{})}
          const index=Number(value);
          if(!Number.isInteger(index)||index<0||index>=s.episodes.length)throw new Error('That episode is not available.');
          s.episode=index;s.epPage=undefined;s.duration=null;s.position=0;this.retries=0;await this.play();
        }else if(op==='season'&&i.isStringSelectMenu()){
          const family=s.title?.family||[];const pick=family[Number(i.values[0])];
          if(!pick||!s.title)throw new Error('That season is not available.');
          await this.load({...pick,family});this.scheduleAutoStart(s);
          return await reply('Starting that season automatically. Camelot counts down 5-4-3-2-1 in the VC chat. Press Stop to cancel.');
        }else if(op==='quality'){
          if(!['playing','paused'].includes(s.phase)||!s.hd)throw new Error('1080p is only offered while a video that supports it is playing.');
          const state=await this.bridge.call<WorkerState>('/api/state');
          if(!['streaming','paused'].includes(state.status))throw new Error('Playback is reconnecting. Try again in a moment.');
          const want=s.quality==='1080p'?'720p':'1080p';
          await this.playback(async()=>{await this.bridge.call('/api/seek',{position:Math.max(0,state.position||s.position),quality:want});s.quality=want;s.position=state.position||s.position});
        }else if(op==='skipb'||op==='skipf'||op==='skipop'){
          if(!['playing','paused'].includes(s.phase))throw new Error('Press Play before skipping.');
          const state=await this.bridge.call<WorkerState>('/api/state');
          if(!['streaming','paused'].includes(state.status))throw new Error('Playback is reconnecting. Try again in a moment.');
          s.position=state.position;s.duration=state.duration;
          if(!s.duration)throw new Error('The source has not reported a duration, so skipping is unavailable.');
          const delta=op==='skipb'?-10:op==='skipf'?30:85;
          const left=s.duration-s.position;
          if(delta>0&&left<=delta+3)throw new Error(`Only ${clock(Math.max(0,left))} left in this episode. Press Next for the next one.`);
          const n=Math.max(0,s.position+delta);
          await this.playback(async()=>{await this.bridge.call('/api/seek',{position:n});s.position=n});
        }else if(op==='seekInput'){
          if(!['playing','paused'].includes(s.phase))throw new Error('Press Play before changing the time.');
          const state=await this.bridge.call<WorkerState>('/api/state');
          if(!['streaming','paused'].includes(state.status))throw new Error('Playback is reconnecting. Try again in a moment.');
          s.position=state.position;s.duration=state.duration;
          const n=i.isModalSubmit()?seconds(i.fields.getTextInputValue('value'),s.position):s.position;
          boundedPosition(n,s.duration);await this.playback(async()=>{await this.bridge.call('/api/seek',{position:n});s.position=n});
        }else if(op==='source'&&i.isStringSelectMenu()){
          const source=i.values[0]!;if(source!=='auto'&&!s.sources.includes(source))throw new Error('That source is no longer available.');s.source=source;this.retries=0;if(s.phase!=='idle')await this.play(s.position);
        }else if(op==='lang'){
          const target=s.lang==='dub'?'sub':'dub';
          const here=s.episodes[s.episode];
          // The episode list holds only listings verified as this exact anime. If none of them has this language for this episode,
          // say so and change nothing, instead of hunting for the language in another version of the show.
          if(s.title&&here&&here.availability?.[target]?.status==='not-listed')throw new Error(`${s.title.title.slice(0,60)} episode ${here.number} has no ${target.toUpperCase()} in the verified sources. Nothing was changed.`);
          s.lang=target;s.subtitle=undefined;if(s.title&&s.phase!=='idle')await this.play(s.position);}
        else if(op==='play'){
          this.retries=0;
          if(s.phase==='playing'){await this.playback(async()=>{await this.bridge.call('/api/pause',{});s.phase='paused';s.position=(await this.bridge.call<WorkerState>('/api/state')).position});}
          else if(s.phase==='paused'){await this.play(s.position);}
          else await this.play(s.position);
        }
        this.persist();await this.paint();
        // The panel itself shows what changed, so a successful press leaves no private message behind.
        if(i.isModalSubmit()||i.isStringSelectMenu()||i.isButton())await i.deleteReply().catch(()=>{});else await reply('Streaming controls updated.');
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
    if(op==='export'){await i.editReply({content:'Streaming diagnostics (no tokens, links or headers). Share this file when reporting a problem.',files:[await this.diagnosticsFile()],allowedMentions:NO_MENTIONS});return}
    if(op==='debugmode'){if(this.bridge.running)await this.bridge.call('/api/diagnostics',{debugSeconds:300});await i.editReply({content:this.bridge.running?'Detailed streaming statistics are on for 5 minutes (once per second in the Railway logs, then back to every 10 seconds).':'Streaming is not running. Start a stream first, then turn this on.',components:[],allowedMentions:NO_MENTIONS});return}
    if(op==='debug'){await i.editReply({content:await this.debugReport(),components:[],allowedMentions:NO_MENTIONS});return}
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
  /** Redacted JSON export for admins: bot timeline + the TV service's own export. Never contains tokens, media links or headers. */
  async diagnosticsFile():Promise<AttachmentBuilder>{
    const tv=this.bridge.running?await this.bridge.call('/api/diagnostics'+(this.cid?'?cid='+encodeURIComponent(this.cid):'')).catch((e:Error)=>({error:'TV diagnostics unavailable: '+e.message.slice(0,120)})):{error:'TV service is not running'};
    const s=this.session;
    const bot={generatedAt:new Date().toISOString(),node:process.version,commit:(process.env.RAILWAY_GIT_COMMIT_SHA||'').slice(0,12)||null,cid:this.cid??null,
      session:s?{phase:s.phase,title:s.title?.title??null,entity:s.title?.entity??null,format:s.title?.format??null,year:s.title?.year??null,subtitle:s.subtitle??null,episode:s.episodes[s.episode]?.number??null,source:s.actualSource||s.source,lang:s.lang,quality:s.quality,queue:s.queue?.length??0,rejoinWanted:this.rejoinWanted,lastWorkerStatus:this.lastWorkerStatus}:null,
      summary:this.cid?botTimeline.summary(this.cid):null,timeline:botTimeline.all().slice(-300)};
    const text=JSON.stringify({bot,tv},null,1).replace(/https?:\/\/[^\s"\\]+/g,'[url]');
    return new AttachmentBuilder(Buffer.from(text,'utf8'),{name:`camelot-streaming-diagnostics-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`});
  }
  /** Plain-text status for admins (Settings → Streaming → Debug info). Never includes tokens or media links. */
  async debugReport():Promise<string>{
    const s=this.session;
    const clean=(t:string)=>t.replace(/https?:\/\/\S+/g,'[link]').replace(/\s+/g,' ').trim();
    const lines=['**Streaming debug** (no tokens or links are shown)'];
    lines.push(s?`Bot: phase **${s.phase}** · owner ${s.owner?`<@${s.owner}>`:'none'} · episode ${s.episodes[s.episode]?.number??'-'} · source ${s.actualSource||s.source} · queue ${s.queue?.length??0} · rejoin ${this.rejoinWanted?'on':'off'}${s.note?`\nNote: ${clean(s.note).slice(0,160)}`:''}`:'Bot: no active session');
    let w:WorkerState|null=null;
    if(this.bridge.running)w=await this.bridge.call<WorkerState>('/api/state').catch(()=>null);
    if(!w)lines.push('TV service: not running (it starts when someone uses /stream).');
    else{
      lines.push(`TV service v${w.version??'?'}: status **${w.status}** · connected ${w.connected} · safe mode ${w.safeMode??false}${w.failReason?` · failReason ${w.failReason}`:''}`);
      if(w.config)lines.push(`Video: ${w.config.resolution} at ${w.config.fps} fps · ${w.config.bitrate} · x264 ${w.config.preset} · ${w.config.threads} threads`);
      for(const fix of w.envFixes??[])lines.push('Setting fixed: '+clean(fix).slice(0,200));
      if(w.lastError)lines.push('Last error: '+clean(w.lastError).slice(0,200));
      const match=(w.logs??[]).filter(l=>/Match report|ACCEPT |REJECT |PENDING |Subtitles:|Source match|Anime search/.test(l.msg)).slice(-10).map(l=>clean(l.msg).slice(0,150));
      if(match.length)lines.push('Which anime / subtitles:\n```\n'+match.join('\n')+'\n```');
      const recent=(w.logs??[]).slice(-6).map(l=>`${l.time} ${l.kind}: ${clean(l.msg).slice(0,140)}`);
      if(recent.length)lines.push('Recent TV log:\n```\n'+recent.join('\n')+'\n```');
    }
    lines.push('The full detail is in the Railway logs; lines starting with [stream] and [tv] are Streaming.');
    return lines.join('\n').slice(0,1950);
  }
  async close(){this.closed=true;this.stopping=true;this.bridge.cancelRequests();if(this.timer)clearInterval(this.timer);if(this.repaint)clearTimeout(this.repaint);await this.bridge.close();this.persist()}
}
export const streaming=new Streaming();
