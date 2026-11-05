import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexTranscript, codexItems } from '../src/transcripts/codex.js';
import { inputHash, normalizeInput } from '../src/input-echo.js';
import { screenCard } from '../src/render.js';
import { legacyHarness, message } from './helpers.js';

const ts = '1970-01-01T00:00:01.000Z';
const rec = (type, payload) => ({ timestamp: ts, type, payload });
const msg = (role, text) => rec('response_item', { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const input = text => ({ id: text, hash: inputHash(text), prefix: normalizeInput(text).slice(0, 64), length: normalizeInput(text).length, sentAt: 0, expires: 600000 });
const lines = records => records.map(r => JSON.stringify(r)).join('\n') + '\n';
async function fixture(t, id, prompt = 'hello', home) {
  home ??= await mkdtemp(join(tmpdir(), 'w7n-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.codex', 'sessions', '1970', '01', '01'); await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-test-${id}.jsonl`);
  await writeFile(path, lines([rec('session_meta', { session_id: id, cwd: '/tmp' }), msg('user', '# AGENTS.md instructions\n<INSTRUCTIONS>injected</INSTRUCTIONS>'), rec('event_msg', { type: 'task_started' }), msg('user', prompt), msg('assistant', 'clean answer'), rec('event_msg', { type: 'task_complete' })]));
  return { home, path };
}

test('projects real messages and tool calls while skipping injected context', async t => {
  assert.deepEqual(codexItems(msg('user', '# AGENTS.md instructions\n<INSTRUCTIONS>x</INSTRUCTIONS>')), []);
  assert.equal(codexItems(msg('user', 'hello'))[0].text, 'hello');
  assert.equal(codexItems(msg('assistant', 'answer'))[0].role, 'assistant');
  assert.match(codexItems(rec('response_item', { type: 'function_call', name: 'exec', arguments: '{"cmd":"dir"}', call_id: 'x' }))[0].text, /🔧 exec: dir/);
  assert.equal(codexItems(rec('event_msg', { type: 'task_complete' }))[0].role, 'turn_end');
  const { home, path } = await fixture(t, 'abc'); const adapter = new CodexTranscript({ home });
  const all = await adapter.read(path, null); assert.deepEqual(all.items.map(i => i.role), ['user', 'assistant', 'turn_end']);
  const end = await adapter.read(path, { atEnd: true }); assert.deepEqual(end.items, []);
  assert.deepEqual((await adapter.read(path, end.cursor)).items, []);
});

test('locates matching prompt, excludes held rollouts and refuses ambiguity', async t => {
  const { home, path } = await fixture(t, 'one');
  const adapter = new CodexTranscript({ home }), pane = { pane_id: 'p', cwd: '/tmp', created_ms: 0 };
  const binding = { chatId: 'a', topicId: 'b', cliCommandSentAt: 0, sentInputs: [input('hello')] };
  assert.equal(await adapter.locate(pane, binding, [binding]), path);
  const second = await fixture(t, 'two', 'hello', home);
  assert.equal(await adapter.locate(pane, binding, [binding]), null);
  assert.equal(await adapter.locate(pane, binding, [binding, { chatId: 'a', topicId: 'other', transcript: { path: second.path } }]), path);
  assert.equal(await adapter.locate(pane, { ...binding, transcript: { adapter: 'codex', path } }, [binding]), path);
});

test('full screen startup and two prompts use one clean turn card per prompt', async t => {
  const home = await mkdtemp(join(tmpdir(), 'w7n-flow-')); t.after(() => rm(home, { recursive: true, force: true }));
  const adapter = new CodexTranscript({ home }); const h = await legacyHarness(t, { adapters: { codex: adapter } });
  const pane = h.fake.create(); Object.assign(pane, { agent: 'codex', agent_status: 'working', cwd: '/tmp', created_ms: 0, visible: '╭────╮\nStarting Codex\n╰────╯' });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  h.advance(2000); await h.bridge.tick();
  const startupId = h.bridge.store.forPane('w1:p1').cardId; assert.ok(startupId);
  const topic = h.bridge.store.forPane('w1:p1').topicId;
  await h.bridge.store.update('oc_test', topic, { cliCommandSentAt: 0 });
  await h.bridge.handle(message('hello', 'm1', topic));
  const { path } = await fixture(t, 'flow', 'hello', home);
  h.advance(2000); await h.bridge.tick();
  let b = h.bridge.store.forPane('w1:p1');
  assert.equal(b.sessionId, 'flow'); assert.equal(b.sessionSource, 'verified'); assert.match(b.turn.text, /clean answer/);
  const calls = () => h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive');
  const first = b.cardId; assert.notEqual(first, startupId); assert.equal(calls().length, 2);
  assert.ok(h.feishu.calls.some(c => c.type === 'patch' && c.id === startupId)); const rendered = () => JSON.stringify(h.feishu.calls.findLast(c => c.id === b.cardId && ['reply', 'patch'].includes(c.type)));
  assert.match(rendered(), /Codex/); assert.match(rendered(), /clean answer/); assert.doesNotMatch(rendered(), /```/);
  const count = calls().length;
  await h.bridge.handle(message('second', 'm2', topic));
  await appendFile(path, lines([rec('event_msg', { type: 'task_started' }), { ...msg('user', 'second'), timestamp: new Date(h.now()).toISOString() }, msg('assistant', 'second answer'), rec('event_msg', { type: 'task_complete' })]));
  h.advance(2000); await h.bridge.tick(); b = h.bridge.store.forPane('w1:p1');
  assert.notEqual(b.cardId, first); assert.equal(calls().length, count + 1); assert.match(rendered(), /second answer/);
  const startup = JSON.stringify(screenCard({ agent: 'codex', status: 'working', text: '╭────╮\nStarting Codex\n╰────╯' }));
  assert.match(startup, /工作中/); assert.match(startup, /Starting Codex/); assert.doesNotMatch(startup, /```|╭/);
  assert.match(JSON.stringify(screenCard({ agent: null, text: '$ hello' })), /```text/);
});
