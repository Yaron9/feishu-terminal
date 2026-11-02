import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyHarness as harness, message } from './helpers.js';

test('rebind discards partly sent output with a note and tags new batches with its generation', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  h.fake.output('w1:p1', '$ ' + 'a'.repeat(12000) + 'OLD TAIL');
  await h.store.update('oc_test', 'm1', { outputBatch: { generation: h.store.binding('oc_test', 'm1').generation,
    checkpoint: 'legacy', next: 0, chunks: [{ text: 'a'.repeat(12000), uuid: 'legacy-first' }, { text: 'OLD TAIL', uuid: 'legacy-tail' }] } });
  const reply = h.feishu.reply.bind(h.feishu);
  h.feishu.reply = async (topic, content, type, uuid) => {
    if (content === 'OLD TAIL') throw new Error('offline');
    return reply(topic, content, type, uuid);
  };
  await h.bridge.tick(); h.advance(1500); await h.bridge.tick();
  const before = h.store.binding('oc_test', 'm1');
  assert.equal(before.outputBatch.next, 1);
  assert.equal(before.outputBatch.generation, before.generation);
  await h.store.update('oc_test', 'm1', { frozen: true });
  await h.bridge.handle(message('/t open w1:p1', 'rebind', 'm1'));
  const after = h.store.binding('oc_test', 'm1');
  assert.notEqual(after.generation, before.generation);
  assert.equal(after.outputBatch, null);
  assert.ok(h.feishu.calls.some(c => c.content === '旧终端未发送完的输出已丢弃'));
  h.feishu.reply = reply;
  await h.bridge.tick(); h.advance(2000); await h.bridge.tick();
  assert.ok(!h.feishu.calls.some(c => c.content === 'OLD TAIL'));
});

test('a rebind during an output send stops later chunks and cannot restore the old batch', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  h.fake.output('w1:p1', '$ ' + 'a'.repeat(12000) + 'STALE TAIL');
  await h.bridge.tick(); h.advance(1500);
  await h.store.update('oc_test', 'm1', { outputBatch: { generation: h.store.binding('oc_test', 'm1').generation,
    checkpoint: 'legacy', next: 0, chunks: [{ text: 'first', uuid: 'legacy-first' }, { text: 'STALE TAIL', uuid: 'legacy-tail' }] } });
  const reply = h.feishu.reply.bind(h.feishu); let rebound = false;
  h.feishu.reply = async (topic, content, type, uuid) => {
    if (type === 'text' && !rebound) {
      rebound = true;
      await h.store.update('oc_test', 'm1', { frozen: true });
      await h.bridge.handle(message('/t open w1:p1', 'rebind', 'm1'));
    }
    return reply(topic, content, type, uuid);
  };
  await h.bridge.tick();
  assert.ok(!h.feishu.calls.some(c => c.content === 'STALE TAIL'));
  assert.equal(h.store.binding('oc_test', 'm1').outputBatch, null);
  assert.equal(h.store.binding('oc_test', 'm1').frozen, false);
});

test('frozen reused panes publish nothing, discard pending work and never subscribe or read until rebind', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await h.subscribed();
  await h.store.update('oc_test', 'm1', {
    outputBatch: { checkpoint: 'old', next: 0, chunks: [{ text: 'old secret', uuid: 'old' }] },
    pendingCard: { nonce: 'pending', uuid: 'card', card: { secret: 'old screen' } },
  });
  Object.assign(h.fake.panes.get('w1:p1'), { terminal_id: 'reused', text: 'NEW SECRET', visible: 'NEW SECRET' });
  const beforeCalls = h.fake.calls.length, beforeMessages = h.feishu.calls.length;
  const restored = await h.restart();
  await h.bridge.tick(); h.advance(2000); await h.bridge.tick();
  assert.equal(restored.binding('oc_test', 'm1').frozen, true);
  assert.equal(h.feishu.calls.length, beforeMessages, 'no output or card publication');
  assert.ok(!h.fake.calls.slice(beforeCalls).some(c => ['pane.read', 'events.subscribe'].includes(c.method)));
  assert.equal(restored.binding('oc_test', 'm1').outputBatch, null);
  assert.equal(restored.binding('oc_test', 'm1').pendingCard, null);
  await h.bridge.handle(message('/t open w1:p1', 'rebind', 'm1'));
  await h.subscribed(); await h.bridge.tick();
  assert.ok(h.feishu.calls.some(c => c.msgType === 'interactive'));
});

test('identity changes freeze, transport failures discard the read without freezing', async t => {
  for (const mode of ['reused', 'unavailable']) {
    const h = await harness(t); await h.bridge.handle(message('pwd')); await h.subscribed();
    const request = h.bridge.herdr.request.bind(h.bridge.herdr); let changed = false;
    h.bridge.herdr.request = async (method, params) => {
      const response = await request(method, params);
      if (method === 'pane.read' && !changed) {
        changed = true;
        if (mode === 'reused') h.fake.panes.get('w1:p1').terminal_id = 'reused';
        else h.fake.fail('pane.get', 'unavailable');
        response.read.text = 'RACING SECRET';
      }
      return response;
    };
    await h.bridge.tick();
    const binding = h.store.binding('oc_test', 'm1');
    assert.equal(Boolean(binding.frozen), mode === 'reused', mode);
    assert.equal(h.feishu.calls.length, 0, mode);
    if (mode === 'reused') {
      assert.equal(binding.outputBatch, null);
      assert.equal(binding.pendingCard, null);
    }
    assert.ok(!JSON.stringify(h.store.list()).includes('RACING SECRET'));
  }
});
