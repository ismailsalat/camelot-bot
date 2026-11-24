import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,CAMELOT_INTERNAL:'1',CAMELOT_ADMIN_KEY:'a'.repeat(32),PORT:'3388'},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
try{
 const base='http://127.0.0.1:3388';
 for(let n=0;n<60;n++){try{if((await fetch(base+'/health')).ok)break}catch{}await sleep(100)}
 const headers={Authorization:'Bearer '+'a'.repeat(32)};
 const state=await fetch(base+'/api/state',{headers});assert.equal(state.status,200);const json=await state.json();assert.equal(json.status,'offline');assert(!JSON.stringify(json).includes('a'.repeat(32)));
 assert.equal((await fetch(base+'/api/state')).status,401);
 assert.equal((await fetch(base+'/api/state',{headers:{Authorization:'Bearer wrong'}})).status,401);
 const providers=await (await fetch(base+'/api/providers',{headers})).json();assert.equal(providers.providers.length,11);
 console.log('PASS: loopback API state, authentication, secret exclusion, 11 provider registrations');
}catch(e){console.error(output);throw e}finally{child.kill('SIGTERM');await sleep(300);if(child.exitCode===null)child.kill('SIGKILL')}
