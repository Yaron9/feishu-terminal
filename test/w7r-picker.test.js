import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { detectMenu } from '../src/menus.js';
import { CodexTranscript } from '../src/transcripts/codex.js';
import { PiTranscript } from '../src/transcripts/pi.js';
import { inputHash } from '../src/input-echo.js';
import { legacyHarness, message } from './helpers.js';

const screen = ` Resume a previous session
 Filter:  Cwd  All    Status:  Active  Archived    Sort:  Updated  Created
 Type to search
  › 9s ago      确认
    1h ago      回应问题
 enter resume   ctrl+a archive   esc exit   ctrl+c exit   tab focus sort/filter   ↑↓ change option
 ctrl+o comfortable view   ctrl+t transcript   ctrl+e expand   ↑↓ browse`;
test('live resume and captured pickers expose only selectable rows', async () => {
  const menu = detectMenu(screen, {status:'idle', cli:'codex'});
  assert.equal(menu.kind, 'list'); assert.deepEqual(menu.items.map(x => x.label), ['9s ago      确认', '1h ago      回应问题']);
  for (const [name, cli, count] of [['codex-model','codex',8],['pi-resume','pi',10],['pi-model','pi',10]]) {
    const text = await readFile(new URL(`./fixtures/w7r/${name}.txt`, import.meta.url), 'utf8');
    const result = detectMenu(text, {status:'idle', cli}); assert.ok(result.kind, name); assert.equal(result.items.length, count, name); assert.equal(result.cursorIndex, 0);
  }
  for (const text of ['› Ask Codex to do anything\n? for shortcuts', 'Here are points:\n1. first\n2. second', screen + '\n› Ask Codex to do anything\n? for shortcuts']) assert.equal(detectMenu(text, {status:'idle',cli:'codex'}).kind, null);
});
test('picker click navigates down and enters', async t => {
  const h = await legacyHarness(t, {adapters:{}}), pane = h.fake.create();
  Object.assign(pane, {agent:'codex', agent_status:'idle', visible:screen, text:screen});
  await h.bridge.handle(message('/t open w1:p1', 'open')); h.advance(2000); await h.bridge.tick();
  const b = h.bridge.store.forPane('w1:p1'); assert.equal(b.cardMenu.items.length, 2);
  await h.bridge.handle({kind:'button',eventId:randomUUID(),chatId:b.chatId,topicId:b.topicId,openId:'ou_test',messageId:b.menuCardId,nonce:b.menuNonce,key:'menu:select:1'});
  const call = h.fake.calls.filter(c => c.method === 'pane.send_keys').at(-1); assert.deepEqual(call.params.keys, ['down','enter']);
});
for (const kind of ['codex','pi']) test(`${kind} follows a unique prompt without replay and respects ambiguity and held paths`, async t => {
  const home = await mkdtemp(join(tmpdir(),'w7r-')); t.after(() => rm(home,{recursive:true,force:true}));
  const dir = kind === 'codex' ? join(home,'.codex','sessions','2026','01','01') : join(home,'.pi','agent','sessions','--tmp--'); await mkdir(dir,{recursive:true});
  const now = Date.now(), ts = new Date(now).toISOString();
  const make = async (id, prompt) => {
    const path = join(dir, kind === 'codex' ? `rollout-test-${id}.jsonl` : `test_${id}.jsonl`);
    const meta = kind === 'codex' ? {type:'session_meta',timestamp:ts,payload:{session_id:id,cwd:'/tmp'}} : {type:'session',timestamp:ts,id,cwd:'/tmp'};
    const msg = text => kind === 'codex' ? {type:'response_item',timestamp:ts,payload:{type:'message',role:'user',content:[{type:'input_text',text}]}} : {type:'message',timestamp:ts,message:{role:'user',content:text}};
    await writeFile(path,[meta,msg('old history'),...(prompt ? [msg(prompt)] : [])].map(JSON.stringify).join('\n')+'\n'); return path;
  };
  const old = await make('old'), next = await make('next','new prompt');
  const adapter = kind === 'codex' ? new CodexTranscript({home}) : new PiTranscript({home});
  const b = {chatId:'a',topicId:'b',cwd:'/tmp',transcript:{adapter:kind,path:old},sentInputs:[{hash:inputHash('new prompt'),sentAt:now-4000,expires:now+60000}]};
  const pane = {pane_id:'p',cwd:'/tmp'};
  assert.equal(await adapter.locate(pane,b,[b],now),next);
  assert.deepEqual((await adapter.read(next,adapter.sessions.get(next).cursor)).items.map(x=>x.text),['new prompt']);
  const other = await make('other','new prompt');
  assert.equal(await adapter.locate(pane,b,[b],now),old);
  assert.equal(await adapter.locate(pane,b,[b,{chatId:'a',topicId:'c',transcript:{path:other}}],now),next);
});

test('bridge switches the saved session and delivers only the resumed answer', async t => {
  const home = await mkdtemp(join(tmpdir(), 'w7r-bridge-')); t.after(() => rm(home, {recursive:true,force:true}));
  const dir = join(home,'.codex','sessions','2026','01','01'); await mkdir(dir,{recursive:true});
  const adapter = new CodexTranscript({home}), h = await legacyHarness(t, {adapters:{codex:adapter}});
  const pane = h.fake.create(); Object.assign(pane,{agent:'codex',agent_status:'idle',cwd:'/tmp',visible:'Ready'});
  const ts = () => new Date(h.now()).toISOString();
  const msg = (role,text) => ({type:'response_item',timestamp:ts(),payload:{type:'message',role,content:[{text}]}});
  const write = async (id, records) => { const path=join(dir,`rollout-test-${id}.jsonl`); await writeFile(path,[{type:'session_meta',timestamp:ts(),payload:{session_id:id,cwd:'/tmp'}},...records].map(JSON.stringify).join('\n')+'\n'); return path; };
  const old=await write('old',[msg('user','old history')]);
  await h.bridge.handle(message('/t open w1:p1','open'));
  let b=h.bridge.store.forPane('w1:p1'); await h.bridge.store.update(b.chatId,b.topicId,{transcript:{adapter:'codex',path:old,cursor:(await adapter.read(old,{atEnd:true})).cursor},sessionId:'old',sessionSource:'verified'});
  await h.bridge.handle(message('new prompt','prompt',b.topicId));
  const next=await write('next',[msg('user','past history'),msg('user','new prompt'),msg('assistant','resumed answer')]);
  h.advance(4000); await h.bridge.tick(); b=h.bridge.store.forPane('w1:p1');
  assert.equal(b.transcript.path,next); assert.equal(b.sessionId,'next'); assert.match(b.turn.text,/resumed answer/); assert.doesNotMatch(b.turn.text,/past history/);
});
