import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, message, eventually } from './helpers.js';

const writes = h => h.fake.calls.filter(c => ['pane.send_text', 'pane.send_keys', 'agent.prompt', 'pane.close'].includes(c.method));
const texts = h => h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'text');

test('restored binding freezes reused pane identity and only explicit rebind permits input', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  h.fake.panes.get('w1:p1').terminal_id = 'term_reused';
  const restored = await h.restart(); const before = writes(h).length;
  await h.bridge.handle(message('echo unsafe', 'm2', 'm1'));
  assert.equal(writes(h).length, before);
  assert.equal(restored.binding('oc_test', 'm1').frozen, true);
  assert.match(texts(h).at(-1).content, /\/t open.*\/t close/);
  await h.bridge.handle(message('/t open w1:p1', 'rebind', 'm1'));
  await h.bridge.handle(message('echo safe', 'm3', 'm1'));
  assert.equal(writes(h).length, before + 2);
});

test('reconnect verifies tab, workspace and missing identity before any kind of write', async t => {
  for (const change of [p => { p.tab_id = 'w1:t99'; }, p => { p.workspace_id = 'other'; }, p => { delete p.terminal_id; }]) {
    const h = await harness(t); await h.bridge.handle(message('pwd')); await h.subscribed();
    change(h.fake.panes.get('w1:p1')); h.fake.disconnectSubscribers();
    await eventually(() => h.fake.subscribers.size === 0);
    await h.subscribed(); const before = writes(h).length;
    for (const [i, text] of ['next', '/t raw next', '/t k enter', '/t close --kill'].entries())
      await h.bridge.handle(message(text, `bad${i}`, 'm1'));
    assert.equal(writes(h).length, before);
    await h.bridge.handle(message('/t close', 'close', 'm1'));
    assert.equal(h.store.list().length, 0);
  }
});

test('legacy bindings without persisted identity fail closed on startup', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  await h.store.update('oc_test', 'm1', { identity: null });
  await h.restart(); const before = writes(h).length;
  await h.bridge.handle(message('unsafe', 'm2', 'm1'));
  assert.equal(writes(h).length, before);
});

test('uncertain shell text or Enter freezes ordinary input across restart until explicit /t ok', async t => {
  for (const method of ['pane.send_text', 'pane.send_keys']) {
    const h = await harness(t); await h.bridge.handle(message('pwd'));
    h.fake.drop(method); await h.bridge.handle(message('danger', 'uncertain', 'm1'));
    assert.equal(h.store.binding('oc_test', 'm1').needs_check, true);
    assert.match(texts(h).at(-1).content, /\/t ok/);
    assert.match(texts(h).at(-1).content, /\$ /);
    await h.restart(); const before = writes(h).length;
    for (const [i, text] of ['next', '/t raw next', '/t k enter'].entries())
      await h.bridge.handle(message(text, `refused${i}`, 'm1'));
    assert.equal(writes(h).length, before);
    await h.bridge.handle(message('/t k ctrl+u', 'clear', 'm1'));
    await h.bridge.handle(message('still refused', 'refused-again', 'm1'));
    assert.equal(writes(h).length, before + 1);
    await h.bridge.handle(message('/t ok', 'checked', 'm1'));
    await h.bridge.handle(message('safe', 'safe', 'm1'));
    assert.equal(writes(h).length, before + 3);
  }
});
