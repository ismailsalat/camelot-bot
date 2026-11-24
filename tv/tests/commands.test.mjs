import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkerCommands} from '../src/commands.mjs';
test('controls wait for matching worker completion, ignoring stale acknowledgments',async()=>{
 let sent;const queue=new WorkerCommands(job=>{sent=job});let done=false;
 const operation=queue.request({op:'pause'}).then(()=>{done=true});
 queue.accept({event:'ack',requestId:'old',ok:true});await Promise.resolve();assert(!done);
 queue.accept({event:'ack',requestId:sent.requestId,ok:true});await operation;assert(done);
});
test('worker errors and disconnects reject pending controls',async()=>{
 let sent;const queue=new WorkerCommands(job=>{sent=job});
 const first=queue.request({op:'seek'});queue.accept({event:'ack',requestId:sent.requestId,ok:false,message:'failed'});await assert.rejects(first,/failed/);
 const second=queue.request({op:'play'});queue.close();await assert.rejects(second,/disconnected/);assert.equal(queue.pending.size,0);
});
test('missing worker acknowledgment times out and removes the pending request',async()=>{
 const queue=new WorkerCommands(()=>{},15);await assert.rejects(queue.request({op:'play'}),/timed out/);assert.equal(queue.pending.size,0);
});
test('closed stdin fails immediately without leaving a pending timer',async()=>{
 const queue=new WorkerCommands(()=>{throw Error('not connected')});await assert.rejects(queue.request({op:'play'}),/not connected/);assert.equal(queue.pending.size,0);
});
