import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyHarness, message, outputReplies } from './helpers.js';

const replies = h => h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive');
const binding = h => h.bridge.store.forPane('w1:p1');
const card = (h, id) => h.feishu.calls.findLast(c => c.id === id && (c.type === 'reply' || c.type === 'patch'));
const body = c => JSON.stringify(c.card ?? c.content);
async function setup(t) {
  const h = await legacyHarness(t, { adapters: {} });
  await h.bridge.handle(message('first'));
  return h;
}
async function screen(h, text, ms = 2000) {
  h.fake.output('w1:p1', text); h.advance(ms); await h.bridge.tick();
}

test('settles patch one interaction card; the next input creates an independent card', async t => {
  const h = await setup(t);
  await screen(h, '$ first\none'); const first = binding(h).cardId;
  await screen(h, '$ first\none\ntwo'); await screen(h, '$ first\none\ntwo\nthree');
  assert.equal(replies(h).length, 1); assert.match(body(card(h, first)), /one.*two.*three/);
  assert.equal(outputReplies(h.feishu).length, 0);
  const old = body(card(h, first));
  await h.bridge.handle(message('second', 'm2', 'm1'));
  await screen(h, '$ first\none\ntwo\nthree\n$ second\nfour');
  assert.equal(replies(h).length, 2); assert.notEqual(binding(h).cardId, first);
  assert.equal(body(card(h, first)), old); assert.match(body(card(h, binding(h).cardId)), /four/);
});

test('full-screen redraws use one card and ignore blank and chrome-only changes', async t => {
  const h = await setup(t);
  h.fake.status('w1:p1', 'working', 'codex');
  const start = ['heading', ...Array(118).fill(''), 'first'].join('\n');
  await screen(h, start); const id = binding(h).cardId;
  await screen(h, start + '\nsecond');
  await screen(h, 'heading\n\nfirst\nsecond\nThinking now');
  const count = h.feishu.calls.filter(c => c.type === 'patch' && c.id === id).length;
  await screen(h, 'heading\nfirst\n\nsecond\nBrewing now');
  assert.equal(replies(h).length, 1);
  assert.equal(h.feishu.calls.filter(c => c.type === 'patch' && c.id === id).length, count);
  assert.match(body(card(h, id)), /heading.*first.*second/);
});

test('restart retains the interaction card and anchor', async t => {
  const h = await setup(t); await screen(h, '$ first\none'); const id = binding(h).cardId;
  await h.restart(); await screen(h, '$ first\none\ntwo');
  assert.equal(binding(h).cardId, id); assert.equal(replies(h).length, 1); assert.match(body(card(h, id)), /one.*two/);
});

test('menu is separate and output resumes on the same card', async t => {
  const h = await setup(t); await screen(h, '$ first\nbefore'); const id = binding(h).cardId;
  h.fake.status('w1:p1', 'blocked', 'codex');
  const pane = h.fake.panes.get('w1:p1'); pane.visible = 'Select model\n❯ First model\n  Second model\nEsc to cancel';
  h.advance(2000); await h.bridge.tick(); const menuId = binding(h).menuCardId;
  assert.ok(menuId && menuId !== id); assert.match(body(card(h, id)), /before/);
  await h.bridge.handle({ kind: 'button', eventId: 'menu-click', chatId: 'oc_test', openId: 'ou_test', topicId: 'm1',
    messageId: menuId, nonce: binding(h).menuNonce, key: 'menu:select:1' });
  h.fake.status('w1:p1', 'idle', 'codex');
  await screen(h, '$ first\nbefore\nafter');
  assert.equal(replies(h).length, 2); assert.equal(binding(h).cardId, id); assert.match(body(card(h, id)), /before.*after/);
});

test('Claude transcript still creates and patches a turn card', async t => {
  const records = [], adapter = { locate: async () => 'turn.jsonl', read: async (_path, cursor) => ({
    cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
  }) };
  const h = await legacyHarness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working';
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  records.push({ role: 'assistant', text: 'first answer' }); h.advance(2000); await h.bridge.tick();
  const id = binding(h).cardId; assert.ok(binding(h).turn); assert.match(body(card(h, id)), /first answer/);
  records.push({ role: 'assistant', text: 'second answer' }); h.advance(2000); await h.bridge.tick();
  assert.equal(binding(h).cardId, id); assert.match(body(card(h, id)), /second answer/);
});

test('large output keeps the tail on one card with a folding note and safe code fence', async t => {
  const h = await setup(t), output = '界'.repeat(30000) + '<tag>```end';
  await screen(h, '$ first\n' + output); await screen(h, '$ first\n' + output);
  assert.equal(replies(h).length, 1);
  const rendered = body(card(h, binding(h).cardId));
  assert.ok(rendered.includes('前面 5017 字已折叠，发送 /t screen 查看'));
  assert.equal((rendered.match(/界/g) ?? []).length, 24989);
  assert.match(rendered, /&lt;tag&gt;/);
  assert.ok(rendered.includes('\u200b'));
});

test('a saved pending publication retries after restart without a duplicate', async t => {
  const h = await setup(t), original = h.feishu.reply;
  h.feishu.reply = async (...args) => {
    h.feishu.reply = original;
    throw Object.assign(new Error('temporary'), { code: 'network_error' });
  };
  await screen(h, '$ first\nretry');
  assert.ok(binding(h).pendingCard); assert.equal(replies(h).length, 0);
  const b = binding(h); await h.bridge.store.update(b.chatId, b.topicId, { screenCardFresh: true, pendingCard: { ...b.pendingCard, screenAnchor: 'legacy overflow anchor' } });
  await h.restart(); h.advance(2000); await h.bridge.tick();
  assert.equal(replies(h).length, 1); assert.equal(binding(h).pendingCard, null);
  assert.match(body(card(h, binding(h).cardId)), /retry/);
  await screen(h, '$ first\nretry\ncontinued'); assert.equal(replies(h).length, 1);
  assert.match(body(card(h, binding(h).cardId)), /continued/);
});

test('a pre-upgrade output batch still drains without changing the new anchor', async t => {
  const h = await setup(t), b = binding(h), anchor = b.lastTranscript;
  await h.bridge.store.update(b.chatId, b.topicId, { outputBatch: {
    generation: b.generation ?? 0, checkpoint: 'old checkpoint', next: 0,
    chunks: [{ text: 'legacy output', uuid: 'legacy-output' }],
  } });
  await h.bridge.flush(binding(h));
  assert.ok(h.feishu.calls.some(c => c.type === 'reply' && c.content === 'legacy output'));
  assert.equal(binding(h).outputBatch, null); assert.equal(binding(h).lastTranscript, anchor);
});
