import {spawn,type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {log} from '../logger.js';

export interface WorkerState {status:string;connected:boolean;guild:string|null;position:number;duration:number|null;streamerId?:string;busy:boolean}
export class Bridge {
  private child:ChildProcess|null=null;
  private key=randomBytes(32).toString('hex');
  private starting:Promise<void>|null=null;
  private closing:Promise<void>|null=null;
  private requests=new AbortController();
  private port=Number(process.env.STREAMING_PORT||'3334');
  cancelRequests(){this.requests.abort(new Error('Playback change cancelled.'));this.requests=new AbortController()}
  private killGroup(child:ChildProcess){
    try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else if(child.exitCode===null)child.kill('SIGKILL')}catch{}
  }
  async start(){
    if(this.closing)throw new Error('Streaming is stopping. Try again in a moment.');
    if(this.starting)return this.starting;
    if(this.child)return;
    this.starting=this.launch();try{await this.starting}finally{this.starting=null}
  }
  private async launch(){
    const env={...process.env,CAMELOT_INTERNAL:'1',CAMELOT_ADMIN_KEY:this.key,PORT:String(this.port)};
    for(const name of ['DISCORD_TOKEN','CAMELOT_STREAMER_TOKEN','CAMELOT_BRIDGE_KEY','STREAMING_SECRET_KEY'])delete (env as Record<string,string|undefined>)[name];
    const child=spawn(process.execPath,[resolve('tv/server.mjs')],{env,detached:process.platform!=='win32',stdio:['ignore','ignore','ignore']});
    this.child=child;
    child.on('error',()=>{if(this.child===child)this.child=null;log.warn('TV service could not start. Check the Streaming setup.');});
    child.on('exit',()=>{if(this.child===child)this.child=null;this.killGroup(child)});
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      if(this.child!==child||this.closing)throw new Error('TV service stopped. Check its installation.');
      try{await this.call('/api/state');return}catch{await sleep(250)}
    }
    await this.close();throw new Error('TV service did not become ready.');
  }
  async call<T=any>(path:string,body?:unknown):Promise<T>{
    const timeout=path==='/api/state'?3000:path==='/api/play'?240000:90000;
    const response=await fetch(`http://127.0.0.1:${this.port}${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(timeout),this.requests.signal])});
    const result=await response.json() as any;
    if(!response.ok)throw new Error(String(result.error||'TV request failed').replace(/https?:\/\/\S+/g,'[source]').slice(0,400));
    return result as T;
  }
  async connect(guild:string,token:string){
    await this.start();let state=await this.call<WorkerState>('/api/state');
    if(state.connected&&state.guild===guild)return;
    if(state.status!=='offline'){await this.close();await this.start()}
    await this.call('/api/connect',{guild,token});
    const deadline=Date.now()+35000;
    while(Date.now()<deadline){
      await sleep(500);state=await this.call<WorkerState>('/api/state');
      if(state.connected&&state.guild===guild)return;
      if(['offline','failed'].includes(state.status))throw new Error('Streaming account could not connect. Check the saved token and server membership.');
    }
    throw new Error('Streaming account connection timed out.');
  }
  async disconnect(){await this.close()}
  async close(){
    if(this.closing)return this.closing;
    this.cancelRequests();
    const child=this.child;if(!child)return;
    this.closing=(async()=>{
      const exited=new Promise<void>(r=>child.once('exit',()=>r()));
      child.kill('SIGTERM');
      if(child.exitCode===null)await Promise.race([exited,sleep(12000)]);
      // The server may have exited while a Python/FFmpeg descendant is still alive.
      this.killGroup(child);
      if(this.child===child)this.child=null;
    })();
    try{await this.closing}finally{this.closing=null}
  }
}
