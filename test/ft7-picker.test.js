import test from 'node:test';
import assert from 'node:assert/strict';
import { actionEvent } from '../src/feishu.js';
import { harness, message, pickerEvent } from './helpers.js';

const kills = h => h.fake.calls.filter(c => c.method === 'pane.close');
const patches = h => h.feishu.calls.filter(c => c.type === 'patch');
const result = h => JSON.stringify(patches(h).at(-1).card);
const click = (h, action, index = 0, override) => h.bridge.handle(pickerEvent(h, action, index, override));
const closeCard = h => h.bridge.handle(message('/t close', 'close', 'm1'));
const noButtons = h => assert.ok(!patches(h).at(-1).card.elements.some(e => e.actions?.length));

test('ls and top-level close show one labeled row per pane with open/close buttons and no terminal writes', async t => {
  const h = await harness(t); h.fake.create(); h.fake.create();
  for (const [i, text] of ['/t ls', '/t close'].entries()) {
    await h.bridge.handle(message(text, `list${i}`));
    const card = h.feishu.calls.at(-1).content;
    assert.equal(card.elements.length, 7);
    assert.deepEqual(card.elements.filter(e => e.actions).map(e => e.actions.map(a => a.text.content)), [['打开', '关闭'], ['打开', '关闭']]);
    assert.match(JSON.stringify(card), /电脑端已有.*未绑定.*w1:p1/);
  }
  assert.ok(!h.fake.calls.some(c => ['pane.close', 'pane.send_text', 'pane.send_keys'].includes(c.method)));
});

test('picker opens a verified unbound pane in a new top-level topic and starts its screen card', async t => {
  const h = await harness(t); h.fake.create();
  await h.bridge.handle(message('/t ls', 'list', 'existing-topic'));
  const event = pickerEvent(h, 'open');
  // Feed the exact SDK callback adapter used in production.
  await h.bridge.handle(actionEvent({ header: { event_id: event.eventId }, event: { operator: { open_id: event.openId },
    context: { open_chat_id: event.chatId, open_message_id: event.messageId },
    action: { value: { topic_id: event.topicId, nonce: event.nonce, key: event.key } } } }));
  const binding = h.store.forPane('w1:p1');
  assert.equal(binding.topicId, h.feishu.calls.find(c => c.type === 'send').id);
  assert.notEqual(binding.topicId, 'existing-topic');
  assert.match(h.feishu.calls.find(c => c.type === 'send').text, /^终端：/);
  assert.ok(binding.cardId); assert.match(result(h), /已打开话题/); noButtons(h);
  await h.bridge.handle({ ...event, eventId: 'replay' });
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 1);
});

test('open on a bound pane resumes the topic and never creates or rebinds it', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  await h.bridge.handle(message('/t ls', 'list'));
  await click(h, 'open');
  assert.match(result(h), /已在话题「.*」\(\d{2}:\d{2}\)，已置顶；看不到可点 \[移到新话题\]/);
  assert.deepEqual(patches(h).at(-1).card.elements.flatMap(e => e.actions ?? []).map(b => b.text.content), ['移到新话题']);
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
  assert.equal(h.store.list().length, 1);
});

test('picker close offers unbind/kill/cancel and unbind keeps the terminal alive', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  await h.bridge.handle(message('/t ls', 'list')); await click(h, 'close');
  assert.deepEqual(patches(h).at(-1).card.elements.find(e => e.actions).actions.map(a => a.text.content), ['仅解绑', '关闭终端', '取消']);
  const old = pickerEvent(h, 'kill');
  await click(h, 'unbind');
  assert.equal(h.store.list().length, 0); assert.equal(kills(h).length, 0);
  assert.ok(h.fake.panes.has('w1:p1')); assert.match(result(h), /已解绑/); noButtons(h);
  await h.bridge.handle(old); assert.equal(kills(h).length, 0);
});

test('topic close waits for a choice; cancelling consumes all sibling buttons', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  const oldKill = pickerEvent(h, 'kill');
  assert.equal(h.store.list().length, 1); await click(h, 'cancel');
  assert.match(result(h), /已取消/); noButtons(h);
  await h.bridge.handle(oldKill); assert.equal(kills(h).length, 0); assert.equal(h.store.list().length, 1);
});

test('owned idle shell closes on the first choice and consumes its nonce across restart', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  const event = pickerEvent(h, 'kill');
  await h.bridge.handle(event);
  assert.equal(kills(h).length, 1); assert.equal(h.store.list().length, 0); assert.match(result(h), /已关闭/); noButtons(h);
  await h.restart(); await h.bridge.handle({ ...event, eventId: 'restart-replay' });
  assert.equal(kills(h).length, 1);
});

test('desktop and owned working/blocked agents require a second confirmation; cancellation and final kill work', async t => {
  for (const mode of ['desktop', 'working', 'blocked']) {
    const h = await harness(t);
    if (mode === 'desktop') { h.fake.create(); await h.bridge.handle(message('/t open w1:p1', 'open')); }
    else { await h.bridge.handle(message('pwd')); h.fake.status('w1:p1', mode); }
    const topic = h.store.forPane('w1:p1').topicId;
    await h.bridge.handle(message('/t close', 'close', topic));
    const first = pickerEvent(h, 'kill'); await h.bridge.handle(first);
    assert.equal(kills(h).length, 0); assert.match(result(h), /确定关闭「.*里面的会话会结束/);
    assert.deepEqual(patches(h).at(-1).card.elements[1].actions.map(a => a.text.content), ['确定关闭', '取消']);
    await h.bridge.handle({ ...first, eventId: 'old-confirm' }); assert.equal(kills(h).length, 0);
    await click(h, 'cancel'); assert.match(result(h), /已取消/);
    await h.bridge.handle(message('/t close', 'close2', topic)); await click(h, 'kill');
    await click(h, 'kill'); assert.equal(kills(h).length, 1); assert.match(result(h), /已关闭/); noButtons(h);
  }
});

test('unbound desktop can be closed through the picker with a second confirmation', async t => {
  const h = await harness(t); h.fake.create();
  await h.bridge.handle(message('/t ls', 'list')); await click(h, 'close'); await click(h, 'kill');
  assert.equal(kills(h).length, 0); await click(h, 'kill');
  assert.equal(kills(h).length, 1); assert.equal(h.store.list().length, 0);
});

test('picker callback ACL, message, topic, nonce, action and index reject forged clicks without consuming the valid card', async t => {
  const h = await harness(t); h.fake.create(); await h.bridge.handle(message('/t ls', 'list'));
  const before = h.fake.calls.length;
  for (const override of [{ openId: 'foreign' }, { chatId: 'foreign' }, { messageId: 'foreign' }, { topicId: 'foreign' },
    { nonce: 'foreign' }, { key: 'picker:kill:0' }, { key: 'picker:open:9' }, { key: 'picker:open:NaN' }]) await click(h, 'open', 0, override);
  assert.equal(h.fake.calls.length, before); assert.equal(h.store.list().length, 0);
  await click(h, 'open'); assert.equal(h.store.list().length, 1);
});

test('picker cards expire at ten minutes, including after restart, with buttons removed', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  const event = pickerEvent(h, 'kill'); h.advance(600000); await h.restart(); await h.subscribed();
  const before = h.fake.calls.length; await h.bridge.handle(event);
  assert.equal(h.fake.calls.length, before); assert.equal(kills(h).length, 0);
  assert.match(result(h), /卡片已过期/); noButtons(h);
});

test('pending picker remains usable across restart before expiry', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  const event = pickerEvent(h, 'unbind'); h.advance(599999); await h.restart(); await h.bridge.handle(event);
  assert.equal(h.bridge.store.list().length, 0); assert.match(result(h), /已解绑/);
});

test('every picker button refuses a reused terminal identity, including cancel and second confirmation', async t => {
  for (const action of ['open', 'close', 'unbind', 'kill', 'cancel', 'confirmed-kill']) {
    const h = await harness(t); h.fake.create();
    if (['open', 'close'].includes(action)) await h.bridge.handle(message('/t ls', 'list'));
    else {
      await h.bridge.handle(message('/t open w1:p1', 'open'));
      await h.bridge.handle(message('/t close', 'close', h.store.forPane('w1:p1').topicId));
      if (action === 'confirmed-kill') await click(h, 'kill');
    }
    h.fake.panes.get('w1:p1').terminal_id = 'reused';
    await click(h, action === 'confirmed-kill' ? 'kill' : action);
    assert.equal(kills(h).length, 0); assert.match(result(h), /终端已变化，请重新 \/t ls/); noButtons(h);
    assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, action === 'open' || action === 'close' ? 0 : 1);
  }
});

test('missing pane in pane.list cannot be killed, even if pane.get still returns it', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  const request = h.bridge.herdr.request.bind(h.bridge.herdr);
  h.bridge.herdr.request = (method, params) => method === 'pane.list' ? Promise.resolve({ panes: [] }) : request(method, params);
  await click(h, 'kill'); assert.equal(kills(h).length, 0); assert.match(result(h), /终端已变化/);
  await h.bridge.handle(message('/t close --kill', 'explicit-kill', 'm1')); assert.equal(kills(h).length, 0);
});

test('pane identity is rechecked after the second confirmation and before the kill request', async t => {
  const h = await harness(t); h.fake.create(); await h.bridge.handle(message('/t ls', 'list'));
  await click(h, 'close'); await click(h, 'kill');
  h.fake.panes.delete('w1:p1'); await click(h, 'kill');
  assert.equal(kills(h).length, 0); assert.match(result(h), /终端已变化/);
});

test('rebinding the same terminal invalidates earlier close choices', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  await h.store.update('oc_test', 'm1', { generation: 'new-generation' });
  await click(h, 'unbind'); assert.equal(h.store.list().length, 1); assert.match(result(h), /终端已变化/);
});

test('failed picker publication falls back to labeled text; an empty list has a readable card', async t => {
  const h = await harness(t); h.fake.create();
  const reply = h.feishu.reply.bind(h.feishu);
  h.feishu.reply = (topic, content, type, uuid) => type === 'interactive' ? Promise.reject(new Error('send failed')) : reply(topic, content, type, uuid);
  await h.bridge.handle(message('/t ls', 'list')); assert.match(h.feishu.calls.at(-1).content, /命令行.*电脑端已有.*未绑定/);
  h.feishu.reply = reply; h.fake.panes.clear(); await h.bridge.handle(message('/t ls', 'empty'));
  assert.match(JSON.stringify(h.feishu.calls.at(-1).content), /暂无终端/);
});

test('explicit close --kill remains immediate for desktop and working agents', async t => {
  const h = await harness(t); const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working';
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  await h.bridge.handle(message('/t close --kill', 'kill', h.store.forPane('w1:p1').topicId));
  assert.equal(kills(h).length, 1); assert.equal(h.store.list().length, 0);
  assert.ok(!h.feishu.calls.some(c => c.msgType === 'interactive'));
});

test('screen buttons also expire after ten minutes and never send a terminal key', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); h.fake.status('w1:p1', 'blocked'); await h.bridge.tick();
  const b = h.store.binding('oc_test', 'm1'), before = h.fake.calls.length; h.advance(600000);
  await h.bridge.handle({ kind: 'button', eventId: 'expired-screen', chatId: 'oc_test', openId: 'ou_test',
    topicId: 'm1', messageId: b.cardId, nonce: b.nonce, key: 'enter' });
  assert.equal(h.fake.calls.length, before); assert.match(h.feishu.calls.at(-1).content, /卡片已过期/);
});

test('picker binds desktop workspaces with exact identity checks while text open keeps its workspace restriction', async t => {
  const h = await harness(t); h.fake.create(); h.fake.workspace().label = 'desktop';
  await h.bridge.handle(message('/t open w1:p1', 'text-open')); assert.equal(h.store.list().length, 0);
  await h.bridge.handle(message('/t ls', 'list')); await click(h, 'open');
  const binding = h.store.forPane('w1:p1'); assert.equal(binding.allowDesktop, true); assert.ok(binding.cardId);
  await h.bridge.handle(message('pwd', 'input', binding.topicId));
  assert.ok(h.fake.calls.some(c => c.method === 'pane.send_text' && c.params.text === 'pwd'));
  await h.restart(); assert.equal(h.bridge.store.forPane('w1:p1').frozen, undefined);
  h.fake.panes.get('w1:p1').tab_id = 'changed';
  await h.bridge.handle(message('unsafe', 'changed', binding.topicId));
  assert.equal(h.bridge.store.forPane('w1:p1').frozen, true);
  assert.ok(!h.fake.calls.some(c => c.params.text === 'unsafe'));
});

test('an owned agent that becomes busy during the click still requires confirmation', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  const audit = h.bridge.audit;
  h.bridge.audit = async record => { await audit(record); h.fake.status('w1:p1', 'working'); };
  await click(h, 'kill'); assert.equal(kills(h).length, 0); assert.match(result(h), /确定关闭/);
});

test('disappearance between initial verification and the final kill check refuses the action', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  const audit = h.bridge.audit;
  h.bridge.audit = async record => { await audit(record); h.fake.panes.delete('w1:p1'); };
  await click(h, 'kill'); assert.equal(kills(h).length, 0); assert.match(result(h), /终端已变化/);
});

test('concurrent picker choices perform only one action and failed result patches cannot revive a kill nonce', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  const event = pickerEvent(h, 'kill');
  const patch = h.feishu.patch.bind(h.feishu);
  h.feishu.patch = async () => { throw new Error('patch failed'); };
  await Promise.all([h.bridge.handle(event), h.bridge.handle({ ...event, eventId: 'concurrent-kill' })]);
  assert.equal(kills(h).length, 1); h.feishu.patch = patch;
  await h.restart(); await h.bridge.handle({ ...event, eventId: 'restart-failed-patch' });
  assert.equal(kills(h).length, 1);
});

test('ambiguous kill failure consumes the card and never retries or unbinds the topic', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await closeCard(h);
  const event = pickerEvent(h, 'kill'); h.fake.drop('pane.close');
  await h.bridge.handle(event); assert.match(result(h), /操作未完成/); noButtons(h);
  assert.equal(h.store.list().length, 1); await h.bridge.handle({ ...event, eventId: 'failed-kill-replay' });
  assert.equal(kills(h).length, 1);
});

test('screen refresh and blocked keys reject changed terminal identities with the picker recovery message', async t => {
  for (const key of ['refresh', 'enter']) {
    const h = await harness(t); await h.bridge.handle(message('pwd')); h.fake.status('w1:p1', 'blocked'); await h.bridge.tick();
    const b = h.store.binding('oc_test', 'm1'); h.fake.panes.get('w1:p1').terminal_id = 'changed';
    const before = h.fake.calls.filter(c => c.method === 'pane.send_keys').length;
    await h.bridge.handle({ kind: 'button', eventId: 'changed-screen', chatId: 'oc_test', openId: 'ou_test',
      topicId: 'm1', messageId: b.cardId, nonce: b.nonce, key });
    assert.equal(h.fake.calls.filter(c => c.method === 'pane.send_keys').length, before);
    assert.match(h.feishu.calls.at(-1).content, /终端已变化，请重新 \/t ls/);
  }
});

