import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, message, pickerEvent } from './helpers.js';
import { route } from '../src/router.js';
import { messageEvent } from '../src/feishu.js';

const sends = h => h.feishu.calls.filter(c => c.type === 'send' && c.text.startsWith('终端：'));
const conversation = h => h.feishu.calls.filter(c => c.type === 'reply' && c.content?.schema === '2.0');
const patched = h => h.feishu.calls.filter(c => c.type === 'patch').at(-1).card;
const buttons = card => card.elements.flatMap(e => e.actions ?? []);
const click = (h, action, overrides = {}) => h.bridge.handle(pickerEvent(h, action, 0, overrides));

async function bound(t, options) {
  const h = await harness(t, options);
  await h.bridge.handle(message('original topic'));
  h.fake.status('w1:p1', 'blocked'); await h.bridge.tick();
  return h;
}

test('move grammar requires a bound topic or explicit pane and preserves phone punctuation rules', () => {
  assert.deepEqual(route('/t move', true), { type: 'move' });
  assert.equal(route('/t move').type, 'error');
  for (const bound of [true, false]) {
    assert.deepEqual(route('/t move w1:p1', bound), { type: 'move', paneId: 'w1:p1' });
    assert.equal(route('/t move w1:p1 extra', bound).type, 'error');
  }
  for (const dash of ['--', '—', '–']) assert.deepEqual(route(`/t close ${dash}kill`, true), { type: 'close', kill: true });
  assert.deepEqual(route('/t raw —kill –kill', true), { type: 'raw', text: '—kill –kill' });
  assert.deepEqual(route('—move –literal', true), { type: 'input', text: '—move –literal' });
});

test('picker move rotates topic, generation, nonce and card, consumes its nonce and starts status', async t => {
  const h = await bound(t), old = h.store.forPane('w1:p1');
  h.fake.create(); await h.bridge.handle(message('/t ls', 'list'));
  const card = h.feishu.calls.at(-1).content;
  assert.deepEqual(buttons(card).map(b => b.text.content), ['打开', '关闭', '移到新话题', '打开', '关闭']);
  assert.match(JSON.stringify(card), /已绑定话题「original topic」\(08:00\)/);
  const event = pickerEvent(h, 'move'); await h.bridge.handle(event);
  const current = h.store.forPane('w1:p1');
  assert.notEqual(current.topicId, old.topicId); assert.notEqual(current.generation, old.generation);
  assert.notEqual(current.cardId, old.cardId); assert.notEqual(current.nonce, old.nonce);
  assert.equal(current.pendingCard, null); assert.equal(current.outputBatch, null);
  assert.equal(current.lastTranscript, old.lastTranscript);
  assert.match(sends(h)[0].text, /^终端：/);
  assert.ok(h.feishu.calls.some(c => c.type === 'reply' && c.topicId === current.topicId && c.msgType === 'interactive'));
  assert.ok(h.feishu.calls.some(c => c.type === 'reply' && c.topicId === old.topicId && /^已移到新话题「/.test(c.content)));
  assert.match(JSON.stringify(patched(h)), /已移到新话题，在列表最上面/);
  assert.match(JSON.stringify(patched(h)), /w1:p2/); assert.equal(buttons(patched(h)).length, 0);
  await h.bridge.handle({ ...event, eventId: 'replay' }); assert.equal(sends(h).length, 1);
  const writes = h.fake.calls.length;
  await h.bridge.handle({ ...event, eventId: 'old-screen', topicId: old.topicId, messageId: old.cardId, nonce: old.nonce, key: 'enter' });
  assert.equal(h.fake.calls.length, writes);
});

test('move keeps the transcript cursor through restart, catches up fresh turns and never replays history', async t => {
  let offset = 10;
  const reads = [];
  const adapter = { locate: async () => 'fixture.jsonl', read: async (path, cursor) => {
    reads.push(cursor);
    return { cursor: { offset }, items: cursor.atEnd || cursor.offset === offset ? [] : [{ role: 'assistant', text: `fresh ${offset}` }] };
  } };
  const h = await harness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working';
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const old = h.store.forPane('w1:p1'); assert.equal(old.transcript.cursor.offset, 10);
  offset = 20; await h.bridge.handle(message('/t move', 'move', old.topicId));
  const current = h.store.forPane('w1:p1'); assert.deepEqual(current.transcript, old.transcript);
  assert.equal(conversation(h).length, 0); assert.equal(reads.filter(c => c.atEnd).length, 1);
  await h.restart(); await h.bridge.tick();
  assert.equal(conversation(h).length, 1); assert.match(JSON.stringify(conversation(h)[0].content), /fresh 20/);
  assert.equal(conversation(h)[0].topicId, current.topicId);
  await h.restart(); await h.bridge.tick(); assert.equal(conversation(h).length, 1);
  offset = 30; h.advance(2000); await h.bridge.tick(); assert.equal(conversation(h).length, 1);
  assert.match(JSON.stringify(h.feishu.calls.filter(c => c.type === 'patch').at(-1).card), /fresh 20[\s\S]*fresh 30/);
  assert.equal(reads.filter(c => c.atEnd).length, 1);
});

test('pending output finishes once in the old topic before the atomic move', async t => {
  const h = await bound(t), old = h.store.forPane('w1:p1');
  await h.store.update(old.chatId, old.topicId, { outputBatch: { generation: old.generation, next: 0,
    checkpoint: 'finished', transcript: { adapter: 'fixture', path: 'x', cursor: { offset: 12 } },
    chunks: [{ text: 'pending old output', uuid: 'durable-output' }] } });
  await h.bridge.handle(message('/t move w1:p1', 'move'));
  const current = h.store.forPane(old.paneId);
  assert.equal(current.outputBatch, null); assert.equal(current.lastTranscript, 'finished');
  assert.equal(current.transcript.cursor.offset, 12);
  const output = h.feishu.calls.filter(c => c.content === 'pending old output');
  assert.equal(output.length, 1); assert.equal(output[0].topicId, old.topicId); assert.equal(output[0].uuid, 'durable-output');
  assert.ok(h.feishu.calls.indexOf(output[0]) < h.feishu.calls.indexOf(sends(h)[0]));
});

test('failed pending output aborts move without dropping or replaying its batch', async t => {
  const h = await bound(t), old = h.store.forPane('w1:p1');
  await h.store.update(old.chatId, old.topicId, { outputBatch: { generation: old.generation, next: 0,
    checkpoint: 'pending', chunks: [{ text: 'pending', uuid: 'same-id' }] } });
  const reply = h.feishu.reply.bind(h.feishu);
  h.feishu.reply = (topic, content, ...args) => content === 'pending' ? Promise.reject(new Error('offline')) : reply(topic, content, ...args);
  await h.bridge.handle(message('/t move w1:p1', 'move'));
  assert.equal(sends(h).length, 0); assert.equal(h.store.forPane(old.paneId).topicId, old.topicId);
  assert.equal(h.store.forPane(old.paneId).outputBatch.chunks[0].uuid, 'same-id');
});

test('old-topic note is best-effort even when every old-topic reply fails', async t => {
  const h = await bound(t), reply = h.feishu.reply.bind(h.feishu);
  h.feishu.reply = (topic, ...args) => topic === 'm1' ? Promise.reject(new Error('hidden old topic')) : reply(topic, ...args);
  await h.bridge.handle(message('/t ls', 'list')); await click(h, 'move');
  assert.notEqual(h.store.forPane('w1:p1').topicId, 'm1');
  assert.match(JSON.stringify(patched(h)), /已移到新话题，在列表最上面/);
});

test('recovered row retains only move with a fresh single-use nonce, including after restart', async t => {
  const h = await bound(t); await h.bridge.handle(message('/t ls', 'list'));
  const old = pickerEvent(h, 'open'); await h.bridge.handle(old);
  const next = pickerEvent(h, 'move'); assert.notEqual(next.nonce, old.nonce);
  assert.deepEqual(buttons(patched(h)).map(b => b.text.content), ['移到新话题']);
  await h.bridge.handle({ ...old, eventId: 'stale-open', key: 'picker:move:0' }); assert.equal(sends(h).length, 0);
  await h.restart(); await h.bridge.handle(next); assert.equal(sends(h).length, 1);
  assert.equal(buttons(patched(h)).length, 0);
  await h.bridge.handle({ ...next, eventId: 'move-replay' }); assert.equal(sends(h).length, 1);
});

test('move enforces picker ACL, chat, nonce, expiry, binding generation and pane identity', async t => {
  for (const mode of ['acl', 'chat', 'nonce', 'expired', 'generation', 'terminal', 'tab', 'missing']) {
    const h = await bound(t); await h.bridge.handle(message('/t ls', 'list'));
    const overrides = mode === 'acl' ? { openId: 'foreign' } : mode === 'chat' ? { chatId: 'foreign' } : mode === 'nonce' ? { nonce: 'foreign' } : {};
    if (mode === 'expired') h.advance(600000);
    if (mode === 'generation') await h.store.update('oc_test', 'm1', { generation: 'changed' });
    if (mode === 'terminal') h.fake.panes.get('w1:p1').terminal_id = 'changed';
    if (mode === 'tab') h.fake.panes.get('w1:p1').tab_id = 'changed';
    if (mode === 'missing') h.fake.panes.clear();
    await click(h, 'move', overrides); assert.equal(sends(h).length, 0, mode);
    assert.equal(h.store.forPane('w1:p1').topicId, 'm1', mode);
    if (['generation', 'terminal', 'tab', 'missing'].includes(mode)) assert.match(JSON.stringify(patched(h)), /终端已变化/);
  }
});

test('text move refuses unbound, foreign-chat and changed identities', async t => {
  for (const mode of ['unbound', 'chat', 'identity']) {
    const h = await bound(t);
    if (mode === 'unbound') await h.store.unbind('oc_test', 'm1');
    if (mode === 'chat') await h.store.transaction(data => { data.bindings[0].chatId = 'foreign'; });
    if (mode === 'identity') h.fake.panes.get('w1:p1').terminal_id = 'changed';
    await h.bridge.handle(message('/t move w1:p1', 'move')); assert.equal(sends(h).length, 0, mode);
  }
});

test('legacy state lazily migrates real root text/time without changing transcript checkpoints', async t => {
  const h = await bound(t);
  await h.store.update('oc_test', 'm1', { topicRoot: undefined, transcript: { path: 'legacy', adapter: 'fixture', cursor: { offset: 42 } } });
  await h.restart();
  h.feishu.getMessage = async id => { assert.equal(id, 'm1'); return { body: { content: JSON.stringify({ text: '终端：' + '长'.repeat(40) }) }, create_time: String(Date.UTC(2026, 10, 1, 23, 58)) }; };
  await h.bridge.handle(message('/t ls', 'list'));
  const card = h.feishu.calls.at(-1).content;
  assert.match(JSON.stringify(card), /已绑定话题「终端：长+…」\(07:58\)/);
  assert.equal(h.bridge.store.forPane('w1:p1').transcript.cursor.offset, 42);
  assert.equal(h.bridge.store.forPane('w1:p1').topicRoot.text.length, 43);
  await click(h, 'move'); assert.equal(h.bridge.store.forPane('w1:p1').transcript.cursor.offset, 42);
  await h.restart(); assert.ok(h.bridge.store.forPane('w1:p1').topicRoot.text.startsWith('终端：'));
});

test('missing legacy root metadata never prevents move and does not invent a timestamp', async t => {
  const h = await bound(t); await h.store.update('oc_test', 'm1', { topicRoot: undefined });
  h.feishu.getMessage = async () => { throw new Error('unavailable'); };
  await h.bridge.handle(message('/t ls', 'list'));
  assert.match(JSON.stringify(h.feishu.calls.at(-1).content), /「m1」\(--:--\)/);
  await click(h, 'move'); assert.equal(sends(h).length, 1);
});

test('user topic creation time comes from the Feishu event rather than delayed delivery', async t => {
  const createdAt = Date.UTC(2026, 10, 1, 23, 58);
  const normalized = messageEvent({ message: { create_time: String(createdAt) } });
  assert.equal(normalized.createdAt, createdAt);
  const h = await harness(t);
  await h.bridge.handle(message('topic before midnight UTC', 'root', 'root', { createdAt: normalized.createdAt }));
  await h.bridge.handle(message('/t ls', 'list'));
  assert.match(JSON.stringify(h.feishu.calls.at(-1).content), /「topic before midnight UTC」\(07:58\)/);
});

test('concurrent move clicks use a nonce only once and a failed result patch cannot revive it', async t => {
  const h = await bound(t); await h.bridge.handle(message('/t ls', 'list'));
  const event = pickerEvent(h, 'move'), patch = h.feishu.patch.bind(h.feishu);
  h.feishu.patch = async () => { throw new Error('patch unavailable'); };
  await Promise.all([h.bridge.handle(event), h.bridge.handle({ ...event, eventId: 'concurrent-move' })]);
  assert.equal(sends(h).length, 1);
  h.feishu.patch = patch; await h.restart();
  await h.bridge.handle({ ...event, eventId: 'replay-after-restart' }); assert.equal(sends(h).length, 1);
});

test('identity is rechecked after audit and after new-topic creation before moving the binding', async t => {
  for (const mode of ['audit', 'send']) {
    const h = await bound(t), old = h.store.forPane('w1:p1');
    await h.bridge.handle(message('/t ls', 'list'));
    if (mode === 'audit') h.bridge.audit = async () => { h.fake.panes.get('w1:p1').terminal_id = 'changed'; };
    else {
      const send = h.feishu.send.bind(h.feishu);
      h.feishu.send = async (...args) => { const id = await send(...args); h.fake.panes.get('w1:p1').terminal_id = 'changed'; return id; };
    }
    await click(h, 'move');
    const current = h.store.forPane(old.paneId);
    assert.equal(current.topicId, old.topicId); assert.equal(current.generation, old.generation);
    assert.match(JSON.stringify(patched(h)), /终端已变化/);
    assert.equal(sends(h).length, mode === 'send' ? 1 : 0);
  }
});

test('foreign-chat rows have no move button and forged move is refused', async t => {
  const h = await bound(t); await h.store.transaction(data => { data.bindings[0].chatId = 'foreign'; });
  await h.bridge.handle(message('/t ls', 'list'));
  assert.deepEqual(buttons(h.feishu.calls.at(-1).content).map(b => b.text.content), ['打开', '关闭']);
  await click(h, 'move'); assert.equal(sends(h).length, 0);
});
