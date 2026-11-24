// Exercise the real HTTP -> stdin -> worker-event path with a fake Discord worker.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'camelot-control-'));
const stub=join(dir,'python-stub');
await writeFile(stub,`#!/usr/bin/env python3
import sys,json,time
def emit(**fields):print('TV_BRIDGE_JSON:'+json.dumps(fields),flush=True)
first=json.loads(sys.stdin.readline())
emit(event='ready',streamerId='333333333333333333',streamer='test',server='test',channels=[{'id':'222222222222222222','name':'test'}])
for line in sys.stdin:
 job=json.loads(line)
 if job['op']=='quit':
  emit(event='ack',requestId=job.get('requestId'),ok=True)
  break
 time.sleep(.15)
 if job['op']=='pause':
  emit(event='ack',requestId=job.get('requestId'),ok=False,message='No active episode')
 elif job['op']=='countdown':
  emit(event='standby',position=0)
  emit(event='ack',requestId=job.get('requestId'),ok=True)
 else:
  emit(event='standby',position=0)
  emit(event='ack',requestId=job.get('requestId'),ok=True)
`);await chmod(stub,0o700);
const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,CAMELOT_INTERNAL:'1',CAMELOT_ADMIN_KEY:'b'.repeat(32),PORT:'3389',PYTHON_BIN:stub},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
const base='http://127.0.0.1:3389';
const headers={Authorization:'Bearer '+'b'.repeat(32),'Content-Type':'application/json'};
const post=(path,body={})=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
try{
 for(let n=0;n<60;n++){try{if((await fetch(base+'/health')).ok)break}catch{}await sleep(100)}
 assert.equal((await post('/api/connect',{token:'test'.repeat(15),guild:'111111111111111111'})).status,202);
 for(let n=0;n<30;n++){if((await (await fetch(base+'/api/state',{headers})).json()).connected)break;await sleep(100)}
 const start=Date.now();assert.equal((await post('/api/standby',{channel:'222222222222222222'})).status,202);assert(Date.now()-start>=130);
 const paused=await post('/api/pause');assert(!paused.ok);assert.match((await paused.json()).error,/No active episode/);
 // The on-stream 5-4-3-2-1: the worker is asked once, and the reply says when the countdown ends so the episode can start exactly then.
 const t0=Date.now();const cd=await post('/api/countdown',{id:'c-1',channel:'222222222222222222'});assert.equal(cd.status,202);
 const cdJson=await cd.json();assert(cdJson.endsAt>=t0+4900&&cdJson.endsAt<=Date.now()+5100,'the countdown lasts 5 seconds from the moment the worker confirms it');
 const bad=await post('/api/countdown',{id:'c-2',channel:'999999999999999999'});assert(!bad.ok);assert.match((await bad.json()).error,/valid voice channel/);
 assert.equal((await post('/api/disconnect')).status,202);
 console.log('PASS: real HTTP controls wait for worker acknowledgments, return worker failures and time the on-stream countdown');
}catch(error){console.error(output);throw error}finally{
 const exited=new Promise(r=>child.once('close',r));child.kill('SIGTERM');await Promise.race([exited,sleep(2000)]);if(child.exitCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});
}
