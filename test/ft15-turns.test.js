import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { legacyHarness as harness, message } from './helpers.js';
import { turnCard } from '../src/render.js';
import { turnChunks } from '../src/turns.js';

const replies = h => h.feishu.calls.filter(c => c.type === 'reply' && c.content?.header?.title.content.startsWith('🤖 '));
const desktop = h => h.feishu.calls.filter(c => c.content?.header?.title.content === '🧑 电脑端输入');
const patches = (h, id) => h.feishu.calls.filter(c => c.type === 'patch' && (!id || c.id === id));
const buttons = card => {
  if (!card || typeof card !== 'object') return [];
  return (card.tag === 'button' ? [card] : []).concat(Object.values(card).flatMap(value =>
    Array.isArray(value) ? value.flatMap(buttons) : value && typeof value === 'object' ? buttons(value) : []));
};
const click = b => ({ kind: 'button', eventId: randomUUID(), chatId: b.chatId, topicId: b.topicId,
  messageId: b.cardId, nonce: b.nonce, openId: 'ou_test', key: 'enter' });

async function setup(t) {
  const records = []; let path = 'turns.jsonl';
  const adapter = { locate: async () => path, read: async (_path, cursor) => ({
    cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
  }) };
  const h = await harness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working';
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const binding = () => h.bridge.store.forPane('w1:p1');
  const poll = async (ms = 0) => {
    h.advance(ms); h.bridge.state(binding()).dirty = true; await h.bridge.tick();
  };
  return { h, pane, records, binding, poll, adapter, rotate(value) { path = value; } };
}

test('many tool batches share one turn card with bounded cumulative text and patches at least two seconds apart', async t => {
  const { h, records, binding, poll } = await setup(t);
  await poll(); assert.equal(h.feishu.calls.filter(c => c.type === 'reply').length, 0);
  records.push({ role: 'user', text: 'desktop start' }, { role: 'assistant', text: 'Start' });
  await poll(); const id = binding().cardId;
  assert.equal(desktop(h).length, 1); assert.equal(replies(h).length, 1);
  assert.equal(replies(h)[0].content.header.title.content, '🤖 Claude · 工作中');
  for (let i = 0; i < 24; i++) {
    records.push({ role: 'assistant', text: `Step ${i}` }, { role: 'tool', text: `🔧 Bash: command ${i}` });
    await poll(250);
  }
  for (let i = 0; i < 4; i++) await poll(2000);
  assert.equal(replies(h).length, 1); assert.equal(binding().cardId, id);
  assert.equal(binding().turn.toolCount, 24);
  const card = patches(h, id).at(-1).card;
  assert.match(card.body.elements[1].content, /Start[\s\S]*Step 23/);
  assert.equal(card.body.elements[2].header.title.content, '🔧 工具调用 (24)');
  assert.equal(card.body.elements[2].expanded, false);
  const times = [replies(h)[0].time, ...patches(h, id).map(c => c.time)];
  assert.ok(times.length > 2);
  assert.ok(times.slice(1).every((time, i) => time - times[i] >= 2000), times.join(','));
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive').length, 2);
});

test('blocked buttons are on the turn card, consume a nonce once, and rotate after the throttle even across restart', async t => {
  const { h, pane, records, binding, poll } = await setup(t);
  records.push({ role: 'assistant', text: 'Need permission' }); await poll();
  pane.agent_status = 'blocked'; await poll(2000);
  const old = binding(), card = patches(h, old.cardId).at(-1).card;
  assert.equal(card.header.title.content, '🤖 Claude · 等待你确认');
  assert.equal(card.header.template, 'orange'); assert.equal(buttons(card).length, 5);
  assert.ok(buttons(card).every(b => b.behaviors[0].value.nonce === old.nonce));
  const writes = () => h.fake.calls.filter(c => c.method === 'pane.send_keys').length;
  const before = writes(); await h.bridge.handle(click(old)); await h.bridge.handle(click(old));
  assert.equal(writes(), before + 1); assert.equal(patches(h, old.cardId).length, 1);
  await h.restart(); await h.bridge.handle(click(old)); assert.equal(writes(), before + 1);
  await poll(2000);
  const current = binding(); assert.notEqual(current.nonce, old.nonce);
  assert.equal(buttons(patches(h, old.cardId).at(-1).card)[0].behaviors[0].value.nonce, current.nonce);
  assert.equal(current.cardId, old.cardId); assert.equal(replies(h).length, 1);
  await h.bridge.handle(click(current)); assert.equal(writes(), before + 2);
});

test('settle finalizes the same card without controls and the next assistant item starts a new turn', async t => {
  const { h, pane, records, binding, poll } = await setup(t);
  records.push({ role: 'assistant', text: 'First answer' }); await poll();
  const first = binding(); pane.agent_status = 'blocked'; await poll(2000);
  pane.agent_status = 'done'; await poll(2000);
  const done = patches(h, first.cardId).at(-1).card;
  assert.equal(done.header.title.content, '🤖 Claude · 已完成'); assert.equal(buttons(done).length, 0);
  assert.equal(binding().turn.settled, true);
  await poll(10000); assert.equal(replies(h).length, 1);
  records.push({ role: 'assistant', text: 'Second answer' }); await poll();
  assert.equal(replies(h).length, 2); assert.notEqual(binding().cardId, first.cardId);
  assert.equal(replies(h)[1].content.body.elements[1].content, 'Second answer');
});

test('a user turn does not settle on the previous idle sample before its first assistant output', async t => {
  const { h, pane, records, binding, poll } = await setup(t);
  pane.agent_status = 'idle'; records.push({ role: 'user', text: 'New question before status update' }); await poll();
  const first = binding(); assert.equal(first.turn.settled, false);
  await poll(2000); await h.restart(); await poll(2000);
  assert.equal(binding().turn.settled, false); assert.equal(replies(h).length, 1);
  pane.agent_status = 'working'; await poll(2000);
  assert.equal(binding().turn.activeObserved, true);
  records.push({ role: 'assistant', text: 'The answer belongs on this card' }); await poll(2000);
  assert.equal(binding().cardId, first.cardId); assert.equal(replies(h).length, 1);
  pane.agent_status = 'idle'; await poll(2000);
  assert.equal(binding().turn.settled, true); assert.equal(patches(h, first.cardId).at(-1).card.header.title.content, '🤖 Claude · 已完成');
});

test('desktop echo precedes its turn; Feishu input starts a turn without an echo and earlier turns are finalized', async t => {
  const { h, records, binding, poll } = await setup(t);
  await h.bridge.handle(message('phone input', 'phone', binding().topicId));
  records.push({ role: 'user', text: 'phone input' }, { role: 'assistant', text: 'Phone answer' });
  await poll(); const first = binding();
  assert.equal(desktop(h).length, 0); assert.equal(replies(h).length, 1);
  records.push({ role: 'user', text: 'desktop input' }, { role: 'assistant', text: 'Desktop answer' });
  await poll(2000);
  assert.equal(replies(h).length, 2); assert.equal(desktop(h).length, 1);
  assert.ok(h.feishu.calls.indexOf(desktop(h)[0]) < h.feishu.calls.indexOf(replies(h)[1]));
  assert.equal(patches(h, first.cardId).at(-1).card.header.title.content, '🤖 Claude · 已完成');
  assert.equal(binding().turn.text, 'Desktop answer'); assert.deepEqual(binding().sentInputs, []);
});

test('restart mid-turn preserves its card, content, checkpoint and patch throttle', async t => {
  const { h, records, binding, poll } = await setup(t);
  records.push({ role: 'assistant', text: 'Before restart' }, { role: 'tool', text: 'First tool' }); await poll();
  const before = binding(); records.push({ role: 'assistant', text: 'After restart' }); await poll(1000);
  assert.equal(patches(h).length, 0); assert.ok(binding().outputBatch);
  await h.restart(); await poll(); assert.equal(patches(h).length, 0);
  await poll(1000);
  assert.equal(replies(h).length, 1); assert.equal(binding().cardId, before.cardId);
  assert.equal(binding().turn.toolCount, 1); assert.match(binding().turn.text, /Before restart\n\nAfter restart/);
  assert.equal(binding().transcript.cursor.offset, 3); assert.equal(binding().outputBatch, null);
  await h.restart(); await poll(2000); assert.equal(patches(h).length, 1);
});

test('gone, recalled and 14-day-expired turn cards get exactly one replacement with the same turn', async t => {
  for (const code of ['230011', '230031', '230110']) {
    const { h, records, binding, poll } = await setup(t);
    records.push({ role: 'assistant', text: 'Before missing card' }); await poll(); const old = binding();
    const patch = h.feishu.patch.bind(h.feishu);
    h.feishu.patch = async (id, card) => {
      if (id === old.cardId) throw Object.assign(new Error('gone'), { code });
      return patch(id, card);
    };
    records.push({ role: 'tool', text: 'Replacement tool' }); await poll(14 * 86400000);
    assert.equal(replies(h).length, 2); assert.notEqual(binding().cardId, old.cardId);
    assert.equal(binding().turn.id, old.turn.id); assert.equal(binding().turn.toolCount, 1);
    await h.restart(); await poll(2000); assert.equal(replies(h).length, 2);
  }
});

test('an uncertain replacement reuses its pending UUID and card across restart', async t => {
  const { h, records, binding, poll } = await setup(t);
  records.push({ role: 'assistant', text: 'Initial answer' }); await poll(); const old = binding();
  h.feishu.patch = async () => { throw Object.assign(new Error('gone'), { code: '230011' }); };
  const reply = h.feishu.reply.bind(h.feishu); let attempted;
  h.feishu.reply = async (topic, card, type, uuid) => { attempted = { card, uuid }; throw new Error('response lost'); };
  records.push({ role: 'assistant', text: 'Continued' }); await poll(2000);
  assert.equal(binding().cardId, old.cardId); assert.equal(binding().pendingCard.targetId, null);
  h.feishu.reply = async (topic, card, type, uuid) => {
    assert.equal(uuid, attempted.uuid); assert.deepEqual(card, attempted.card); return reply(topic, card, type, uuid);
  };
  await h.restart(); await poll(2000);
  assert.equal(replies(h).length, 2); assert.equal(binding().outputBatch, null);
});

test('an uncertain patch preserves the old nonce and retries its fixed version after the persisted throttle', async t => {
  const { h, pane, records, binding, poll } = await setup(t);
  pane.agent_status = 'blocked'; records.push({ role: 'assistant', text: 'Need permission' }); await poll();
  const old = binding(), patch = h.feishu.patch.bind(h.feishu); let attempts = 0, attempted;
  h.feishu.patch = async (_id, card) => { attempts++; attempted = card; throw new Error('response lost'); };
  records.push({ role: 'tool', text: 'Pending tool' }); await poll(2000);
  assert.equal(attempts, 1); assert.equal(binding().nonce, old.nonce);
  const pending = binding().pendingCard;
  await h.restart(); await poll(1000); assert.equal(attempts, 1);
  h.feishu.patch = async (id, card) => { assert.deepEqual(card, attempted); await patch(id, card); };
  await poll(1000);
  assert.equal(binding().nonce, pending.nonce); assert.equal(binding().pendingCard, null);
  assert.equal(binding().outputBatch, null); assert.equal(replies(h).length, 1);
  const before = h.fake.calls.filter(c => c.method === 'pane.send_keys').length;
  await h.bridge.handle(click(old)); assert.equal(h.fake.calls.filter(c => c.method === 'pane.send_keys').length, before);
});

test('a pending turn finishes after restart even when its transcript adapter is unavailable', async t => {
  const { h, records, binding, poll, adapter } = await setup(t);
  records.push({ role: 'assistant', text: 'Before outage' }); await poll(); const old = binding();
  records.push({ role: 'assistant', text: 'Durable pending text' }); await poll(1000);
  assert.ok(binding().outputBatch); adapter.locate = async () => null;
  await h.restart(); await poll(1000);
  assert.equal(binding().outputBatch, null); assert.equal(binding().cardId, old.cardId);
  const card = patches(h, old.cardId).at(-1).card;
  assert.equal(card.schema, '2.0'); assert.match(JSON.stringify(card), /Before outage[\s\S]*Durable pending text/);
  assert.equal(binding().transcript.cursor.offset, 2);
});

test('an ambiguous turn creation stops retrying before the UUID deduplication window expires', async t => {
  const { h, records, binding, poll } = await setup(t);
  let attempts = 0;
  h.feishu.reply = async () => { attempts++; throw new Error('unknown delivery'); };
  records.push({ role: 'assistant', text: 'Uncertain first card' }); await poll();
  assert.equal(attempts, 1); const pending = binding().pendingCard;
  h.advance(55 * 60 * 1000); await h.restart(); await poll();
  assert.equal(attempts, 1); assert.equal(binding().pendingCard.uuid, pending.uuid);
  assert.equal(binding().transcript.cursor.offset, 0); assert.ok(binding().outputBatch);
});

test('recovery bumps the topic with the same turn content and cursor, retires controls, then keeps patching', async t => {
  const { h, pane, records, binding, poll } = await setup(t);
  pane.agent_status = 'blocked'; records.push({ role: 'assistant', text: 'Approval text' }, { role: 'tool', text: 'Tool' });
  await poll(); const old = binding();
  await h.bridge.handle(message('/t open w1:p1', 'recover'));
  const recovered = binding(); assert.notEqual(recovered.cardId, old.cardId);
  assert.equal(recovered.turn.id, old.turn.id); assert.deepEqual(recovered.transcript, old.transcript);
  assert.match(JSON.stringify(replies(h)[1].content), /📍 已从终端列表恢复[\s\S]*Approval text/);
  const writes = h.fake.calls.filter(c => c.method === 'pane.send_keys').length;
  await h.bridge.handle(click(old)); assert.equal(h.fake.calls.filter(c => c.method === 'pane.send_keys').length, writes);
  assert.equal(patches(h, old.cardId).length, 0); await poll(2000);
  assert.match(JSON.stringify(patches(h, old.cardId).at(-1).card), /已移至下方新卡片/);
  records.push({ role: 'tool', text: 'Next tool' }); await poll(2000);
  assert.equal(binding().cardId, recovered.cardId); assert.equal(replies(h).length, 2);
  assert.equal(binding().turn.toolCount, 2);
});

test('move carries the live turn into a new topic without replaying text, tools or history on restart', async t => {
  const { h, records, binding, poll } = await setup(t);
  records.push({ role: 'assistant', text: 'Move this answer' }, { role: 'tool', text: 'One tool' }); await poll();
  const old = binding(); await h.bridge.handle(message('/t move', 'move', old.topicId));
  const moved = binding(); assert.notEqual(moved.topicId, old.topicId); assert.notEqual(moved.cardId, old.cardId);
  assert.deepEqual(moved.turn, old.turn); assert.deepEqual(moved.transcript, old.transcript);
  assert.notEqual(moved.generation, old.generation); assert.equal(replies(h)[1].topicId, moved.topicId);
  await h.restart(); records.push({ role: 'tool', text: 'Second tool' }); await poll(2000);
  assert.equal(replies(h).length, 2); assert.equal(binding().turn.toolCount, 2);
  assert.equal(patches(h, moved.cardId).at(-1).card.body.elements[2].header.title.content, '🔧 工具调用 (2)');
});

test('move preserves a throttled output batch and completes it in the old topic before moving', async t => {
  const { h, records, binding, poll } = await setup(t);
  records.push({ role: 'assistant', text: 'Original' }); await poll(); const old = binding();
  records.push({ role: 'tool', text: 'Unpublished tool' }); await poll(1000);
  const batch = binding().outputBatch;
  await h.bridge.handle(message('/t move', 'move-too-early', old.topicId));
  assert.equal(binding().topicId, old.topicId); assert.deepEqual(binding().outputBatch, batch);
  h.advance(1000); await h.bridge.handle(message('/t move', 'move-ready', old.topicId));
  assert.notEqual(binding().topicId, old.topicId); assert.equal(binding().outputBatch, null);
  assert.equal(binding().transcript.cursor.offset, 2); assert.equal(binding().turn.toolCount, 1);
  const root = h.feishu.calls.find(c => c.type === 'send' && c.id === binding().topicId);
  const oldPatch = patches(h, old.cardId).at(-1);
  assert.ok(h.feishu.calls.indexOf(oldPatch) < h.feishu.calls.indexOf(root));
});

test('ft13 state and pending legacy output migrate without dropping UUIDs or replaying the transcript', async t => {
  const { h, records, binding, poll } = await setup(t);
  const old = binding();
  await h.bridge.store.update(old.chatId, old.topicId, { cardId: 'ft13-live', nonce: 'ft13-nonce', cardCreatedAt: 0,
    outputBatch: { generation: old.generation, next: 0, checkpoint: 'legacy screen',
      chunks: [{ text: 'Legacy pending reply', uuid: 'ft13-pending-uuid' }] } });
  await h.restart(); await poll();
  const legacy = h.feishu.calls.find(c => c.content === 'Legacy pending reply');
  assert.equal(legacy.uuid, 'ft13-pending-uuid');
  records.push({ role: 'assistant', text: 'Fresh turn after ft13' }); await poll(2000);
  assert.equal(replies(h).length, 1); assert.equal(binding().turn.text, 'Fresh turn after ft13');
  assert.match(JSON.stringify(patches(h, 'ft13-live').at(-1).card), /已移至下方新卡片/);
  await h.restart(); await poll(2000); assert.equal(replies(h).length, 1);
});

test('expired blocked controls refuse keys, /t screen renews them and still sends the full viewport', async t => {
  const { h, pane, records, binding, poll } = await setup(t);
  pane.agent_status = 'blocked'; pane.visible = 'Full viewport with terminal chrome';
  records.push({ role: 'assistant', text: 'Waiting' }); await poll(); const old = binding();
  h.advance(600000); await h.bridge.handle(click(old));
  assert.ok(h.feishu.calls.some(c => typeof c.content === 'string' && c.content.includes('卡片已过期')));
  assert.equal(h.fake.calls.filter(c => c.method === 'pane.send_keys').length, 0);
  await h.bridge.handle(message('/t screen', 'screen', old.topicId));
  assert.notEqual(binding().nonce, old.nonce); assert.equal(binding().cardId, old.cardId);
  assert.equal(replies(h).length, 1);
  assert.ok(h.feishu.calls.some(c => c.content?.header?.title.content === '💻 当前屏幕' && JSON.stringify(c.content).includes(pane.visible)));
});

test('turn text, tools and worst-case escaped blocked cards stay bounded and retain a truncation marker', () => {
  for (const char of ['🙂', '中', '&', '<', '`', '\\', '"']) {
    const source = { key: 'claude', path: 'fixture' };
    const items = Array.from({ length: 1000 }, () => [{ role: 'assistant', text: char.repeat(2000) }, { role: 'tool', text: char.repeat(2000) }]).flat();
    const { chunks } = turnChunks(items, null, source, 'Claude', 'blocked', [], () => '');
    assert.equal(chunks.length, 1); const turn = chunks[0].turn;
    assert.equal(turn.toolCount, 1000); assert.equal(Array.from(turn.text).length, 1500);
    assert.ok(Array.from(turn.tools).length <= 1500); assert.equal(turn.truncated, true);
    const card = turnCard({ turn, topicId: 'topic', nonce: 'nonce' });
    assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000, char);
    assert.match(card.body.elements[0].content, /仅显示末尾/); assert.equal(buttons(card).length, 5);
    assert.equal(JSON.stringify(card).includes('\ufffd'), false);
  }
});
