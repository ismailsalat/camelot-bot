// A worker killed by a signal must be reported with its signal, recent output and memory limits,
// the pending request must fail cleanly, and the next connection must run in safe mode (720p30).
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'camelot-crash-'));
const stub=join(dir,'python-stub'),envDump=join(dir,'env.txt');
await writeFile(stub,`#!/usr/bin/env python3
import sys,json,os,signal
def emit(**f):print('TV_BRIDGE_JSON:'+json.dumps(f),flush=True)
json.loads(sys.stdin.readline())
open(${JSON.stringify(envDump)},'a').write(os.environ.get('STREAM_RESOLUTION','')+'|'+os.environ.get('STREAM_FFMPEG_THREADS','')+'\\n')
emit(event='ready',streamerId='333333333333333333',streamer='test',server='test',channels=[{'id':'222222222222222222','name':'test'}])
print('some worker output before the crash',file=sys.stderr,flush=True)
for line in sys.stdin:
 job=json.loads(line)
 if job['op']=='stop':os.kill(os.getpid(),signal.SIGKILL)
 emit(event='ack',requestId=job.get('requestId'),ok=True)
`);await chmod(stub,0o700);
const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,CAMELOT_INTERNAL:'1',CAMELOT_ADMIN_KEY:'c'.repeat(32),PORT:'3391',PYTHON_BIN:stub,STREAM_RESOLUTION:'1920:1080'},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
const base='http://127.0.0.1:3391',headers={Authorization:'Bearer '+'c'.repeat(32),'Content-Type':'application/json'};
const post=(path,body={})=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
const state=async()=>(await fetch(base+'/api/state',{headers})).json();
const connect=async()=>{assert.equal((await post('/api/connect',{token:'test'.repeat(15),guild:'111111111111111111'})).status,202);for(let n=0;n<40;n++){if((await state()).connected)return;await sleep(100)}throw new Error('never connected')};
try{
 for(let n=0;n<60;n++){try{if((await fetch(base+'/health')).ok)break}catch{}await sleep(100)}
 await connect();
 // The stub kills itself with SIGKILL when asked to stop; the pending request must fail cleanly.
 const stopped=await post('/api/stop');assert(!stopped.ok);
 for(let n=0;n<40;n++){if(/signal SIGKILL/.test(output))break;await sleep(100)}
 assert.match(output,/Streamer process ended: reason=killed_by_SIGKILL initiated_by=worker .*signal=SIGKILL intentional=false/);
 assert.match(output,/worker: some worker output before the crash/);
 assert.match(output,/Container memory limit:/);
 assert.match(output,/Safe mode on/);
 assert((await state()).safeMode===true);
 await connect();
 await sleep(200);
 const {readFile}=await import('node:fs/promises');
 const lines=(await readFile(envDump,'utf8')).trim().split('\n');
 assert.equal(lines[0],'1920:1080|');assert.equal(lines[1],'1280:720|3');
 console.log('PASS: a signal-killed worker is explained in the log and the reconnect uses safe mode');
}catch(error){console.error(output);throw error}finally{
 const exited=new Promise(r=>child.once('close',r));child.kill('SIGTERM');await Promise.race([exited,sleep(2000)]);if(child.exitCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});
}
