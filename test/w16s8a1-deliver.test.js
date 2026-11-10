import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/bridge.js';
import { userCard } from '../src/render.js';
import { legacyHarness, message, eventually } from './helpers.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const desktop = h => h.feishu.calls.filter(c => c.type === 'reply' && c.content?.header?.title?.content === '🧑 电脑端输入');
const botReplies = h => h.feishu.calls.filter(c => c.type === 'reply' && c.content?.header?.title?.content?.startsWith('🤖 '));

// Deliveries are driven by the caller's own fakes: only the chain, the idle
// gate, the input path and the turnSettled event matter here.
function fakes() {
  const bridge = Object.create(Bridge.prototype), rows = new Map(), sends = [];
  Object.assign(bridge, {
    deliveryChains: new Map(), deliveryEvents: new EventEmitter(), queues: new Map(),
    store: { binding: (chatId, topicId) => rows.get(`${chatId}:${topicId}`) },
    feishu: { reply: async () => 'card' }, onError: () => {},
    input: async (binding, text) => { sends.push({ topicId: binding.topicId, text }); },
    wake: { route: async (binding, action) => { sends.push({ topicId: binding.topicId, text: action.text }); binding.dormant = false; } },
  });
  const add = (id, extra = {}) => rows.set(`oc:${id}`, { chatId: 'oc', topicId: id, sessionId: `session-${id}`, ...extra });
  const deliver = (id, text = id, timeoutMs = 2000) => bridge.deliver({ chatId: 'oc', topicId: id, text, from: '测试员', timeoutMs });
  const settle = (id, turnId, text) => bridge.deliveryEvents.emit('turnSettled',
    { chatId: 'oc', topicId: id, turnId, text, sessionId: `session-${id}` });
  const tick = () => bridge.deliveryEvents.emit('tick');
  return { bridge, rows, sends, add, deliver, settle, tick };
}

test('live topic: the answer is the next settled turn', async () => {
  const f = fakes(); f.add('a', { turn: { id: 'old', settled: true } });
  const done = f.deliver('a', '只回复 PONG');
  await pause();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].text, '[来自 测试员]\n只回复 PONG');
  f.settle('a', 'empty', '');
  await pause();
  f.settle('a', 'new', 'PONG');
  assert.deepEqual(await done, { answer: 'PONG', sessionId: 'session-a' });
});

test('an earlier open turn is waited out and never taken as the answer', async () => {
  const f = fakes(); f.add('a', { turn: { id: 'old', settled: false } });
  const done = f.deliver('a');
  await pause();
  assert.equal(f.sends.length, 0);
  f.rows.get('oc:a').turn.settled = true; f.tick();
  await pause();
  assert.equal(f.sends.length, 1);
  f.settle('a', 'old', 'stale answer');
  f.tick(); await pause();
  let settled = false; done.then(() => { settled = true; }, () => { settled = true; });
  await pause();
  assert.equal(settled, false);
  f.settle('a', 'new', 'right answer');
  assert.deepEqual(await done, { answer: 'right answer', sessionId: 'session-a' });
});

test('queued inputs also hold a delivery back', async () => {
  const f = fakes(); f.add('a', { queuedInputs: [{ id: 'q', type: 'input', text: 'earlier' }] });
  const done = f.deliver('a');
  await pause();
  assert.equal(f.sends.length, 0);
  f.rows.get('oc:a').queuedInputs = []; f.tick();
  await pause();
  assert.equal(f.sends.length, 1);
  f.settle('a', 'new', 'after the queue');
  assert.equal((await done).answer, 'after the queue');
});

test('dormant topic: wake through the Feishu input path, then answer', async () => {
  const f = fakes(); f.add('a', { dormant: true, wakePending: true });
  const done = f.deliver('a');
  await pause();
  assert.equal(f.sends.length, 1);
  assert.equal(f.rows.get('oc:a').dormant, false);
  f.settle('a', 'new', 'woken');
  assert.equal((await done).answer, 'woken');
});

test('two deliveries to one topic serialize, each with its own answer', async () => {
  const f = fakes(); f.add('a');
  const first = f.deliver('a', 'one'), second = f.deliver('a', 'two');
  await pause();
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].text, /one$/);
  f.settle('a', 't1', 'answer one');
  assert.equal((await first).answer, 'answer one');
  await pause();
  assert.equal(f.sends.length, 2);
  assert.match(f.sends[1].text, /two$/);
  f.settle('a', 't2', 'answer two');
  assert.equal((await second).answer, 'answer two');
});

test('two topics are independent and run in parallel', async () => {
  const f = fakes(); f.add('a'); f.add('b');
  const a = f.deliver('a'), b = f.deliver('b');
  await pause();
  assert.equal(f.sends.length, 2);
  f.settle('b', 'tb', 'B');
  f.settle('a', 'ta', 'A');
  assert.equal((await a).answer, 'A');
  assert.equal((await b).answer, 'B');
});

test('a delivery that never settles rejects with timeout', async () => {
  const f = fakes(); f.add('a');
  await assert.rejects(f.deliver('a', 'text', 20), { code: 'timeout' });
});

test('an unknown topic rejects with no_topic', async () => {
  const f = fakes();
  await assert.rejects(f.deliver('missing'), { code: 'no_topic' });
});

// The real bridge: the user card, the Feishu input path and the settled turn
// card publication are exercised end to end with a fake transcript.
async function realBridge(t) {
  const records = [];
  const adapter = { locate: async () => 'deliver.jsonl', read: async (_path, cursor) =>
    ({ cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset) }) };
  const h = await legacyHarness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working';
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const binding = () => h.bridge.store.forPane('w1:p1');
  const poll = async (ms = 0) => { h.advance(ms); h.bridge.state(binding()).dirty = true; await h.bridge.tick(); };
  return { h, pane, records, binding, poll };
}

test('the user card is posted and the published settled turn card is the answer', { timeout: 30000 }, async t => {
  const { h, pane, records, binding, poll } = await realBridge(t);
  const open = binding();

  const done = h.bridge.deliver({ chatId: open.chatId, topicId: open.topicId, text: '只回复 PONG',
    from: '测试员', timeoutMs: 20000 });
  const typed = () => h.fake.calls.some(call => call.method === 'agent.prompt' &&
    call.params.text === '[来自 测试员]\n只回复 PONG');
  await eventually(typed, 'the delivered input in the terminal');
  await h.drain();
  const cards = desktop(h);
  assert.equal(cards.length, 1, 'the delivered message shows as one user card');
  assert.deepEqual(cards[0].content, userCard('[来自 测试员]\n只回复 PONG'));
  assert.ok(typed(), 'the input went through the terminal');
  assert.equal(botReplies(h).length, 0, 'nothing is answered before the turn runs');

  records.push({ role: 'user', text: '[来自 测试员]\n只回复 PONG' }, { role: 'assistant', text: 'PONG' });
  await poll();
  assert.equal(desktop(h).length, 1, 'the matched echo does not post a second user card');
  pane.agent_status = 'idle';
  await poll(2000); await poll(2000);
  assert.deepEqual(await done, { answer: 'PONG', sessionId: open.sessionId });
  assert.equal(botReplies(h).length, 1);
  const cardId = botReplies(h)[0].id;
  const last = h.feishu.calls.filter(call => call.type === 'patch' && call.id === cardId).at(-1)?.card ?? botReplies(h)[0].content;
  assert.equal(last.header.title.content, '🤖 Claude · 已完成');
  assert.match(JSON.stringify(last), /PONG/);
});

test('a turn that settles before its first card is published is still the answer', { timeout: 30000 }, async t => {
  const { h, pane, records, binding, poll } = await realBridge(t);
  const open = binding();
  const done = h.bridge.deliver({ chatId: open.chatId, topicId: open.topicId, text: '只回复 SHORT', from: '测试员', timeoutMs: 20000 });
  await eventually(() => h.fake.calls.some(call => call.method === 'agent.prompt' &&
    call.params.text === '[来自 测试员]\n只回复 SHORT'), 'the delivered input in the terminal');
  await h.drain();
  assert.equal(desktop(h).length, 1);
  pane.agent_status = 'idle';
  records.push({ role: 'user', text: '[来自 测试员] 只回复 SHORT' }, { role: 'assistant', text: 'SHORT' });
  await poll();
  assert.deepEqual(await done, { answer: 'SHORT', sessionId: open.sessionId });
  assert.equal(botReplies(h).length, 1);
  assert.equal(botReplies(h)[0].content.header.title.content, '🤖 Claude · 已完成');
});
