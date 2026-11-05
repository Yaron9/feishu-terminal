import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { legacyHarness, message } from './helpers.js';
const menu = 'Select model\n❯ First model\n  Second model\nEsc to cancel';
const b = h => h.bridge.store.forPane('w1:p1');
const replies = h => h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive');
const last = (h, id) => h.feishu.calls.findLast(c => c.id === id && ['patch', 'reply'].includes(c.type));
const keys = h => h.fake.calls.filter(c => c.method === 'pane.send_keys');
const tick = async (h, ms = 2000) => { h.advance(ms); await h.bridge.tick(); };
const click = (h, nonce = b(h).menuNonce) => h.bridge.handle({ kind: 'button', eventId: randomUUID(), chatId: b(h).chatId, topicId: b(h).topicId, openId: 'ou_test', messageId: b(h).menuCardId, nonce, key: 'menu:select:1' });
async function setup(t, turn = false) {
  const records = [], adapter = { locate: async () => 'turn.jsonl', read: async (_p, cursor) => ({ cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset) }) };
  const h = await legacyHarness(t, { adapters: turn ? { claude: adapter } : {} });
  if (turn) { const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working'; await h.bridge.handle(message('/t open w1:p1', 'open')); records.push({ role: 'assistant', text: 'body before' }); await tick(h); }
  else { await h.bridge.handle(message('first')); h.fake.output('w1:p1', '$ first\nbody before'); await tick(h); }
  return { h, pane: h.fake.panes.get('w1:p1'), records };
}
for (const turn of [false, true]) test(`${turn ? 'turn' : 'screen'} menu shares interaction card and disappears`, async t => {
  const { h, pane } = await setup(t, turn), id = b(h).cardId, n = replies(h).length;
  h.fake.status('w1:p1', 'blocked', turn ? 'claude' : 'codex'); pane.visible = 'body before\n\n' + menu; await tick(h);
  assert.equal(b(h).menuCardId, id); assert.equal(replies(h).length, n);
  assert.match(JSON.stringify(last(h, id).card), /body before/); assert.match(JSON.stringify(last(h, id).card), /Second model/);
  const before = keys(h).length; await click(h); assert.equal(keys(h).length, before + 1); assert.equal(replies(h).length, n);
  h.fake.status('w1:p1', 'idle', turn ? 'claude' : 'codex'); pane.visible = 'finished'; await tick(h, 3000);
  assert.equal(b(h).menuCardId, null); assert.doesNotMatch(JSON.stringify(last(h, id).card), /interactive_container/);
});
test('body patch preserves nonce; changed choices reject the old click', async t => {
  const { h, pane, records } = await setup(t, true); h.fake.status('w1:p1', 'blocked', 'claude'); pane.visible = menu; await tick(h);
  const nonce = b(h).menuNonce; records.push({ role: 'assistant', text: 'more body' }); await tick(h);
  assert.match(JSON.stringify(last(h, b(h).cardId).card), /more body/);
  const before = keys(h).length; assert.equal(b(h).menuNonce, nonce); await click(h, nonce); assert.equal(keys(h).length, before + 1);
  await tick(h); const old = b(h).menuNonce; pane.visible = menu.replace('Second model', 'Other model'); await tick(h);
  await click(h, old); assert.equal(keys(h).length, before + 1);
});
test('menu without a card creates exactly one', async t => {
  const h = await legacyHarness(t, { adapters: {} }), pane = h.fake.create();
  Object.assign(pane, { agent: 'codex', agent_status: 'blocked', visible: menu, text: menu });
  await h.bridge.handle(message('/t open w1:p1', 'open')); h.fake.status('w1:p1', 'blocked', 'codex'); await tick(h);
  assert.equal(replies(h).length, 1); assert.equal(b(h).cardId, b(h).menuCardId);
});
test('legacy separate menu is retired once', async t => {
  const { h, pane } = await setup(t), id = b(h).cardId;
  h.fake.status('w1:p1', 'blocked', 'codex'); pane.visible = menu; await tick(h);
  await h.bridge.store.update(b(h).chatId, b(h).topicId, { menuCardId: 'legacy-menu', menuAttemptAt: null }); await h.bridge.publishMenuCard(b(h));
  assert.equal(h.feishu.calls.filter(c => c.type === 'patch' && c.id === 'legacy-menu').length, 1);
  assert.equal(b(h).menuCardId, id); await tick(h); assert.equal(h.feishu.calls.filter(c => c.type === 'patch' && c.id === 'legacy-menu').length, 1);
});
test('pending menu patch survives restart without duplicate reply', async t => {
  const { h, pane } = await setup(t), id = b(h).cardId, n = replies(h).length, patch = h.feishu.patch.bind(h.feishu);
  h.fake.status('w1:p1', 'blocked', 'codex'); pane.visible = menu;
  h.feishu.patch = async () => { throw new Error('temporary'); }; await tick(h); assert.ok(b(h).pendingMenuCard);
  h.feishu.patch = patch; await h.restart(); await tick(h, 3000);
  assert.equal(b(h).pendingMenuCard, null); assert.equal(b(h).menuCardId, id); assert.equal(replies(h).length, n);
});



test('menu choice followed by a new transcript turn stays on the card until the next prompt', async t => {
  const { h, pane, records } = await setup(t, true);
  records.push({ role: 'turn_end' }); await tick(h);
  const id = b(h).cardId, count = replies(h).length;
  h.fake.status('w1:p1', 'blocked', 'claude'); pane.visible = menu; await tick(h);
  await click(h);
  h.fake.status('w1:p1', 'working', 'claude'); pane.visible = 'working';
  records.push({ role: 'assistant', text: 'after menu choice' }); await tick(h, 3000);
  assert.equal(b(h).cardId, id); assert.equal(replies(h).length, count);
  assert.match(JSON.stringify(last(h, id).card), /after menu choice/);
  await h.bridge.handle(message('real prompt', 'new-prompt', b(h).topicId));
  records.push({ role: 'user', text: 'real prompt' }, { role: 'assistant', text: 'new answer' }); await tick(h, 3000);
  assert.notEqual(b(h).cardId, id); assert.equal(replies(h).length, count + 1);
});
