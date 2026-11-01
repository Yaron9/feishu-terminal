import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, message } from './helpers.js';

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

test('identity changes or verification fails across a read drops the entire snapshot and freezes', async t => {
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
    await h.bridge.tick(); h.advance(2000); await h.bridge.tick();
    const binding = h.store.binding('oc_test', 'm1');
    assert.equal(binding.frozen, true, mode);
    assert.equal(h.feishu.calls.length, 0, mode);
    assert.equal(binding.outputBatch, null);
    assert.equal(binding.pendingCard, null);
    assert.ok(!JSON.stringify(h.store.list()).includes('RACING SECRET'));
  }
});
