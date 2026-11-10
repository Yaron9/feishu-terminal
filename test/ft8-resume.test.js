import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { legacyHarness as harness, message, pickerEvent } from './helpers.js';

const screens = h => h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive' && !c.content.header?.title.content.startsWith('终端列表'));
const writes = h => h.fake.calls.filter(c => ['pane.send_text', 'pane.send_keys', 'agent.prompt', 'pane.close'].includes(c.method));
const screenClick = binding => ({ kind: 'button', eventId: randomUUID(), chatId: binding.chatId, openId: 'ou_test',
  topicId: binding.topicId, messageId: binding.cardId, nonce: binding.nonce, key: 'enter' });

async function blocked(t) {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  h.fake.status('w1:p1', 'blocked'); await h.bridge.tick();
  return h;
}

test('picker recovery replies in the existing topic, commits a new screen nonce, and retires old controls', async t => {
  const h = await blocked(t), old = h.store.binding('oc_test', 'm1');
  h.fake.panes.get('w1:p1').visible = 'current approval'; h.fake.create();
  await h.bridge.handle(message('/t ls', 'list'));
  const picker = pickerEvent(h, 'open');
  const reply = h.feishu.reply.bind(h.feishu);
  h.feishu.reply = async (topic, card, type, uuid) => {
    if (type === 'interactive' && JSON.stringify(card).includes('📍 已从终端列表恢复')) {
      const pending = h.store.binding('oc_test', 'm1');
      assert.equal(topic, 'm1'); assert.equal(pending.cardId, old.cardId); assert.equal(pending.nonce, old.nonce);
      assert.equal(pending.pendingCard.uuid, uuid); assert.equal(pending.pendingCard.targetId, null);
      assert.notEqual(pending.pendingCard.nonce, old.nonce);
    }
    return reply(topic, card, type, uuid);
  };
  await h.bridge.handle(picker);
  const active = h.store.binding('oc_test', 'm1'), screen = screens(h).at(-1);
  assert.equal(active.cardId, screen.id); assert.notEqual(active.cardId, old.cardId);
  assert.equal(active.pendingCard, null); assert.notEqual(active.nonce, old.nonce);
  assert.equal(active.generation, old.generation); assert.equal(active.lastTranscript, old.lastTranscript);
  assert.match(JSON.stringify(screen.content), /📍 已从终端列表恢复/);
  assert.match(JSON.stringify(screen.content), /current approval/);
  const retired = h.feishu.calls.find(c => c.type === 'patch' && c.id === old.cardId);
  assert.match(JSON.stringify(retired.card), /已移至下方新卡片/);
  assert.ok(!JSON.stringify(retired.card).includes('behaviors'));
  const result = h.feishu.calls.find(c => c.type === 'patch' && c.id === picker.messageId).card;
  assert.match(result.elements[0].text.content, /^已在话题「.*」\(\d{2}:\d{2}\)，已置顶；看不到可点 \[移到新话题\]$/);
  assert.equal(result.elements.length, 4); // Preserve the other pane's row, grey id and the move escape.
  assert.ok(!JSON.stringify(result).includes('"url"'));
  const move = result.elements.find(e => e.actions).actions;
  assert.equal(move.length, 1); assert.equal(move[0].text.content, '移到新话题');
  assert.notEqual(move[0].value.nonce, picker.nonce);
  const before = writes(h).length;
  await h.bridge.handle(screenClick(old)); assert.equal(writes(h).length, before);
  await h.bridge.handle(screenClick(active)); assert.equal(writes(h).length, before + 1);
  await h.bridge.handle({ ...picker, eventId: 'picker-replay' });
  assert.equal(screens(h).length, 2); assert.equal(h.store.list().length, 1);
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
});

test('text open recovers at top level and refuses a different topic while bumping the bound topic', async t => {
  const h = await blocked(t), before = writes(h).length;
  await h.bridge.handle(message('/t open w1:p1', 'top-open'));
  assert.equal(screens(h).at(-1).topicId, 'm1');
  await h.bridge.handle(message('echo other', 'other'));
  const other = h.store.binding('oc_test', 'other');
  await h.bridge.handle(message('/t open w1:p1', 'cross-open', 'other'));
  assert.equal(screens(h).at(-1).topicId, 'm1');
  assert.match(h.feishu.calls.at(-1).content, /^该终端已绑定在话题「.*」，已为你置顶该话题$/);
  assert.equal(h.feishu.calls.at(-1).topicId, 'other');
  assert.deepEqual(h.store.binding('oc_test', 'other'), other);
  assert.equal(h.store.list().length, 2); assert.equal(writes(h).length, before + 2); // Only echo other + Enter.
  await h.bridge.handle(message('/t open w1:p1', 'same-open', 'm1'));
  assert.equal(screens(h).at(-1).topicId, 'm1');
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
});

test('uncertain recovery retains the old active nonce and retries the same pending reply UUID on restart', async t => {
  const h = await blocked(t), old = h.store.binding('oc_test', 'm1');
  const reply = h.feishu.reply.bind(h.feishu); let attempted;
  h.feishu.reply = async (topic, card, type, uuid) => {
    if (type === 'interactive') { attempted = { topic, card, uuid }; throw new Error('uncertain delivery'); }
    return reply(topic, card, type, uuid);
  };
  await h.bridge.handle(message('/t open w1:p1', 'recover'));
  const pending = h.store.binding('oc_test', 'm1');
  assert.equal(pending.cardId, old.cardId); assert.equal(pending.nonce, old.nonce);
  assert.equal(pending.pendingCard.uuid, attempted.uuid);
  assert.ok(!h.feishu.calls.some(c => c.type === 'patch' && c.id === old.cardId));
  h.feishu.reply = async (topic, card, type, uuid) => {
    if (type === 'interactive') { assert.equal(uuid, attempted.uuid); assert.deepEqual(card, attempted.card); }
    return reply(topic, card, type, uuid);
  };
  await h.restart();
  const active = h.bridge.store.binding('oc_test', 'm1');
  assert.equal(active.pendingCard, null); assert.equal(active.nonce, pending.pendingCard.nonce);
  assert.notEqual(active.cardId, old.cardId);
  assert.equal(screens(h).at(-1).topicId, 'm1');
  assert.match(JSON.stringify(h.feishu.calls.at(-1).card), /已移至下方新卡片/);
  const before = writes(h).length; await h.bridge.handle(screenClick(old)); assert.equal(writes(h).length, before);
});

test('failed old-card retirement survives restart without republishing the recovery card', async t => {
  const h = await blocked(t), old = h.store.binding('oc_test', 'm1');
  const patch = h.feishu.patch.bind(h.feishu);
  h.feishu.patch = async (id, card) => {
    if (id === old.cardId) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    return patch(id, card);
  };
  await h.bridge.handle(message('/t open w1:p1', 'recover'));
  const active = h.store.binding('oc_test', 'm1');
  assert.equal(active.retiredCardId, old.cardId); assert.notEqual(active.cardId, old.cardId);
  const count = screens(h).length, before = writes(h).length;
  await h.bridge.handle(screenClick(old)); assert.equal(writes(h).length, before);
  const restartAt = h.feishu.calls.length;
  h.feishu.patch = patch; await h.restart();
  assert.equal(h.bridge.store.binding('oc_test', 'm1').retiredCardId, undefined);
  assert.equal(h.bridge.store.binding('oc_test', 'm1').cardId, active.cardId);
  assert.equal(screens(h).length, count);
  assert.match(JSON.stringify(h.feishu.calls.at(-1).card), /已移至下方新卡片/);
  assert.ok(!h.feishu.calls.slice(restartAt).some(c => c.type === 'patch' && c.id === active.cardId));
  assert.ok(!JSON.stringify(h.feishu.calls.slice(restartAt)).includes('undefined'));
  // The first verified read supplies the real status/screen for the header
  // refresh deferred at startup, without recreating the recovery reply.
  h.fake.panes.get('w1:p1').visible = 'Approval after restart';
  h.advance(1000); await h.bridge.tick();
  const refreshed = h.feishu.calls.findLast(c => c.type === 'patch' && c.id === active.cardId);
  assert.ok(refreshed);
  assert.match(JSON.stringify(refreshed.card), /Approval after restart/);
  assert.match(refreshed.card.header.title.content, /等待你确认/);
  assert.equal(screens(h).length, count);
});

test('recovery refuses changed identities and bindings owned by another chat', async t => {
  for (const mode of ['identity', 'chat', 'picker-chat']) {
    const h = await blocked(t), count = screens(h).length;
    if (mode === 'identity') h.fake.panes.get('w1:p1').terminal_id = 'replacement';
    else await h.store.transaction(data => { data.bindings[0].chatId = 'foreign-chat'; });
    if (mode === 'picker-chat') {
      await h.bridge.handle(message('/t ls', 'list')); await h.bridge.handle(pickerEvent(h, 'open'));
    } else await h.bridge.handle(message('/t open w1:p1', 'recover'));
    assert.equal(screens(h).length, count); assert.equal(h.store.list().length, 1);
    assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
  }
});

test('frozen bindings recover in their original topic after explicit revalidation', async t => {
  const h = await blocked(t); await h.store.update('oc_test', 'm1', { frozen: true });
  await h.bridge.handle(message('/t open w1:p1', 'recover', 'other-topic'));
  assert.equal(h.store.binding('oc_test', 'm1').frozen, false);
  assert.equal(screens(h).at(-1).topicId, 'm1');
  assert.match(JSON.stringify(screens(h).at(-1).content), /📍 已从终端列表恢复/);
  assert.match(h.feishu.calls.at(-1).content, /^该终端已绑定在话题「.*」，已为你置顶该话题$/);
  assert.equal(h.store.list().length, 1);
});

test('recovery reconciles an older pending ft7 patch before posting a new reply', async t => {
  const h = await blocked(t), old = h.store.binding('oc_test', 'm1');
  const patch = h.feishu.patch.bind(h.feishu);
  h.feishu.patch = async () => { throw new Error('offline'); };
  h.fake.output('w1:p1', 'new approval'); h.advance(1000); await h.bridge.tick();
  const pending = h.store.binding('oc_test', 'm1').pendingCard;
  assert.equal(pending.targetId, old.cardId); assert.equal(pending.previousCardId, undefined);
  h.feishu.patch = patch;
  await h.bridge.handle(message('/t open w1:p1', 'recover'));
  const active = h.store.binding('oc_test', 'm1');
  const reconciled = h.feishu.calls.find(c => c.type === 'patch' && c.id === old.cardId && c.card.body?.elements.some(e => e.tag === 'button'));
  assert.equal(reconciled.card.body.elements.find(e => e.tag === 'button').behaviors[0].value.nonce, pending.nonce);
  assert.notEqual(active.nonce, pending.nonce); assert.notEqual(active.cardId, old.cardId);
  assert.equal(active.pendingCard, null); assert.equal(h.store.list().length, 1);
});

test('concurrent opens serialize by pane and create only one topic', async t => {
  const h = await harness(t); h.fake.create();
  await Promise.all(['first', 'second'].map(id => h.bridge.handle(message('/t open w1:p1', id))));
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 1);
  assert.equal(h.store.list().length, 1);
  assert.equal(screens(h).at(-1).topicId, h.store.forPane('w1:p1').topicId);
});

test('bridge forwards ordinary and raw phone dashes byte for byte and accepts all kill spellings', async t => {
  for (const option of ['—kill', '–kill', '--kill']) {
    const h = await harness(t); await h.bridge.handle(message('echo —keep –these'));
    assert.equal(writes(h)[0].params.text, 'echo —keep –these');
    await h.bridge.handle(message('/t raw —kill –kill --kill', 'raw', 'm1'));
    assert.equal(writes(h).at(-1).params.text, '—kill –kill --kill');
    await h.bridge.handle(message(`/t close ${option}`, 'kill', 'm1'));
    assert.equal(h.store.list().length, 0); assert.equal(h.fake.panes.size, 0);
    assert.equal(writes(h).at(-1).method, 'pane.close');
  }
});
