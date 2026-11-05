import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiTranscript, piItems } from '../src/transcripts/pi.js';
import { inputHash, normalizeInput } from '../src/input-echo.js';
import { legacyHarness, message } from './helpers.js';

const ts = '1970-01-01T00:00:01.000Z';
const msg = (role, content, stopReason) => ({ type: 'message', id: role, timestamp: ts, message: { role, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, stopReason } });
const lines = records => records.map(r => JSON.stringify(r)).join('\n') + '\n';
const input = text => ({ id: text, hash: inputHash(text), prefix: normalizeInput(text).slice(0, 64), length: normalizeInput(text).length, sentAt: 0, expires: 600000 });
async function fixture(t, id, home) {
  home ??= await mkdtemp(join(tmpdir(), 'w7o-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.pi', 'agent', 'sessions', '--tmp--'); await mkdir(dir, { recursive: true });
  const path = join(dir, `1970-01-01_${id}.jsonl`);
  await writeFile(path, lines([{ type: 'session', id, cwd: '/tmp', timestamp: ts, version: 3 }, msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')]));
  return { home, path };
}
test('projects pi messages, tools and terminal reasons', async t => {
  const blocks = [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'answer' }, { type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'ls' } }];
  assert.deepEqual(piItems(msg('assistant', blocks, 'toolUse')).map(i => i.role), ['assistant', 'tool']);
  assert.match(piItems(msg('assistant', blocks, 'toolUse'))[1].text, /🔧 bash: ls/);
  for (const reason of ['stop', 'error', 'aborted']) assert.equal(piItems(msg('assistant', [], reason)).at(-1).role, 'turn_end');
  const error = msg('assistant', [], 'error'); error.message.errorMessage = 'failed'; assert.equal(piItems(error)[0].text, 'failed');
  assert.deepEqual(piItems(msg('toolResult', 'hidden')), []); assert.deepEqual(piItems(msg('system', 'hidden')), []);
  const { home, path } = await fixture(t, 'abc'); const adapter = new PiTranscript({ home });
  assert.deepEqual((await adapter.read(path, null)).items.map(i => i.role), ['user', 'assistant', 'turn_end']);
  const end = await adapter.read(path, { atEnd: true }); assert.deepEqual((await adapter.read(path, end.cursor)).items, []);
});
test('locates unique matching pi session and excludes other bindings', async t => {
  const { home, path } = await fixture(t, 'one'); const adapter = new PiTranscript({ home });
  const pane = { pane_id: 'p', cwd: '/tmp' }, binding = { chatId: 'a', topicId: 'b', cliCommandSentAt: 0, sentInputs: [input('hello')] };
  assert.equal(await adapter.locate(pane, binding, [binding]), path);
  const other = await fixture(t, 'two', home); assert.equal(await adapter.locate(pane, binding, [binding]), null);
  assert.equal(await adapter.locate(pane, binding, [binding, { chatId: 'a', topicId: 'c', transcript: { path: other.path } }]), path);
  assert.equal(await adapter.locate(pane, { ...binding, transcript: { adapter: 'pi', path } }, [binding]), path);
  const restarted = new PiTranscript({ home });
  assert.equal(await restarted.locate(pane, { ...binding, transcript: { adapter: 'pi', path } }, [binding]), path);
  assert.equal(restarted.sessions.get(path).sessionId, 'one');
});
test('pi streams one clean turn card for each prompt', async t => {
  const home = await mkdtemp(join(tmpdir(), 'w7o-flow-')); t.after(() => rm(home, { recursive: true, force: true }));
  const adapter = new PiTranscript({ home }), h = await legacyHarness(t, { adapters: { pi: adapter } });
  const pane = h.fake.create(); Object.assign(pane, { agent: 'pi', agent_status: 'working', cwd: '/tmp', created_ms: 0, visible: 'Starting Pi' });
  await h.bridge.handle(message('/t open w1:p1', 'open')); h.advance(2000); await h.bridge.tick();
  const startup = h.bridge.store.forPane('w1:p1').cardId, topic = h.bridge.store.forPane('w1:p1').topicId;
  await h.bridge.store.update('oc_test', topic, { cliCommandSentAt: 0 }); await h.bridge.handle(message('hello', 'm1', topic));
  const { path } = await fixture(t, 'flow', home); h.advance(2000); await h.bridge.tick();
  let b = h.bridge.store.forPane('w1:p1'); assert.equal(b.sessionId, 'flow'); assert.equal(b.sessionSource, 'verified');
  const calls = () => h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive');
  const rendered = () => JSON.stringify(h.feishu.calls.findLast(c => c.id === b.cardId && ['reply', 'patch'].includes(c.type)));
  const first = b.cardId; assert.notEqual(first, startup); assert.equal(calls().length, 2); assert.match(rendered(), /Pi/); assert.match(rendered(), /clean answer/); assert.doesNotMatch(rendered(), /```/);
  await h.bridge.handle(message('second', 'm2', topic));
  await appendFile(path, lines([{ ...msg('user', 'second'), timestamp: new Date(h.now()).toISOString() }, msg('assistant', 'second answer', 'stop')]));
  h.advance(2000); await h.bridge.tick(); b = h.bridge.store.forPane('w1:p1');
  assert.notEqual(b.cardId, first); assert.equal(calls().length, 3); assert.match(rendered(), /second answer/); assert.doesNotMatch(rendered(), /```/);
});
