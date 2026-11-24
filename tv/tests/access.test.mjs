import test from 'node:test';
import assert from 'node:assert/strict';
import {apiAccess,originAllowed} from '../src/access.mjs';
const bridgeKey='b'.repeat(40),adminKey='a'.repeat(40),settings={cloud:true,bridgeKey,adminKey};
test('bot key controls playback but cannot connect, disconnect, or obtain credentials',()=>{
 const req={method:'POST',headers:{authorization:`Bearer ${bridgeKey}`}};
 assert.equal(apiAccess(req,'/api/play',settings),'bridge');
 assert.equal(apiAccess(req,'/api/stop',settings),'bridge');
 assert.equal(apiAccess(req,'/api/connect',settings),null);
 assert.equal(apiAccess(req,'/api/disconnect',settings),null);
 assert.equal(apiAccess({...req,headers:{authorization:'Bearer wrong'}},'/api/play',settings),null);
 assert.equal(apiAccess({method:'GET',headers:{}},'/api/state',settings),null);
});
test('trusted bot requests need no browser Origin; local browser requests still do',()=>{
 const req={method:'POST',headers:{host:'localhost:3333'}};
 assert.equal(originAllowed(req,{role:'bridge'}),true);
 assert.equal(originAllowed(req,{role:'local'}),false);
 assert.equal(originAllowed({...req,headers:{...req.headers,origin:'https://evil.example'}},{role:'local'}),false);
 assert.equal(originAllowed({...req,headers:{...req.headers,origin:'http://localhost:3333'}},{role:'local'}),true);
});
