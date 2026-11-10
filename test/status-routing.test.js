import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createBridge } from '../src/lib.js';
import { isStatusCommand } from '../src/status-commands.js';

test('status and usage are intercepted only for authorized users and never sent to a terminal', async () => {
  const tmp=await mkdtemp(join(process.cwd(),'.status-test-'));const sent=[];let reads=0;let bridge;
  try {
    const group={operatorOpenIds:['owner']};const registry={get:id=>id==='group'?group:null,list:()=>[group]};
    const transport={send:async (id,text)=>{sent.push(['send',id,text]);return 'm';},reply:async(id,text)=>{sent.push(['reply',id,text]);return 'm';},patch:async()=>{},getMessage:async()=>({})};
    const backend={list:async()=>[],dispose:async()=>{},subscribe:()=>()=>{},sendText:async()=>{throw new Error('terminal input forbidden');}};
    bridge=createBridge({config:{operatorOpenIds:['owner'],defaultCwd:tmp},registry,backends:backend,transport,
      storeFile:join(tmp,'state.json'),auditFile:join(tmp,'audit.jsonl'),
      usageReader:async()=>{reads++;return 'usage fixture';},statusReader:async()=>{reads++;return 'status fixture';}});
    await bridge.start({timers:false});let n=0;
    const event=(chat,type,user,text,reply=false)=>{const id=`m${++n}`;return {header:{event_id:`e${n}`,event_type:'im.message.receive_v1'},event:{sender:{sender_id:{open_id:user},sender_type:'user'},message:{message_id:id,chat_id:chat,chat_type:type,message_type:'text',content:JSON.stringify({text}),...(reply?{root_id:'topic'}:{})}}};};
    assert.equal(await bridge.handle(event('private','p2p','owner','/usage')),true);assert.deepEqual(sent.pop(),['send','private','usage fixture']);
    assert.equal(await bridge.handle(event('private','p2p','owner','状态')),true);assert.deepEqual(sent.pop(),['send','private','status fixture']);
    assert.equal(await bridge.handle(event('group','group','owner','/状态',true)),true);assert.deepEqual(sent.pop(),['reply','topic','status fixture']);
    assert.equal(await bridge.handle(event('group','group','owner','状态')),true);assert.deepEqual(sent.pop(),['send','group','status fixture']);
    assert.equal(reads,4);
    assert.equal(await bridge.handle(event('private','p2p','stranger','/usage')),true);assert.equal(reads,4);assert.deepEqual(sent,[]);
    assert.equal(await bridge.handle(event('unknown','group','owner','/usage')),false);assert.equal(await bridge.handle(event('private','p2p','owner','hello')),false);
    assert.equal(isStatusCommand({kind:'message',text:'状态',chatType:'group',isReply:true}),false);
    assert.equal(isStatusCommand({kind:'message',text:'/状态',chatType:'group',isReply:true}),true);
  } finally { if(bridge)await bridge.stop();await rm(tmp,{recursive:true,force:true}); }
});
