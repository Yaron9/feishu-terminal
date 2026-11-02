import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyHarness as harness, message } from './helpers.js';
import { Feishu } from '../src/feishu.js';

test('obsolete and unknown buttons reply disabled without reads, writes or nonce consumption', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  const b = h.store.binding('oc_test', 'm1');
  const before = h.fake.calls.length, audits = h.audits.length;
  for (const [i, key] of ['background-output', 'unknown-action', undefined, 'picker:obsolete:0'].entries()) {
    await h.bridge.handle({ kind: 'button', eventId: `obsolete-${i}`, chatId: b.chatId, topicId: b.topicId,
      messageId: 'old-card', nonce: 'old-nonce', openId: 'ou_test', key });
    assert.equal(h.feishu.calls.at(-1).content, '该按钮已停用');
  }
  assert.equal(h.fake.calls.length, before); assert.equal(h.audits.length, audits);
  assert.deepEqual(h.store.binding('oc_test', 'm1'), b);
});

test('restart with pending unpatchable retirement permits rebind and never retries the stale card', async t => {
  for (const code of ['230011', '230031', '230110', '230099', '400', 'binding_unverified']) {
    const h = await harness(t); await h.bridge.handle(message('pwd'));
    await h.store.update('oc_test', 'm1', { retiredCardId: 'stale-card' });
    const patch = h.feishu.patch.bind(h.feishu); let attempts = 0;
    h.feishu.patch = async (id, card) => {
      if (id === 'stale-card') { attempts++; throw Object.assign(new Error('Card cannot be updated'), { code }); }
      return patch(id, card);
    };
    await h.restart();
    const active = h.bridge.store.binding('oc_test', 'm1');
    assert.equal(active.retiredCardId, undefined);
    const log = h.errors.find(line => line.startsWith('card_retirement_failed '));
    assert.deepEqual(JSON.parse(log.slice(log.indexOf(' ') + 1)), { topic: 'm1', cardId: 'stale-card',
      code, message: 'Card cannot be updated', attempt: 1, disposition: 'abandoned' });
    await h.bridge.handle(message('/t open w1:p1', 'rebind'));
    for (let i = 0; i < 8; i++) { h.advance(60000); await h.bridge.tick(); }
    await h.restart();
    assert.equal(attempts, 1);
    assert.notEqual(h.bridge.store.binding('oc_test', 'm1').cardId, active.cardId);
  }
});

test('network retirement failures back off and exhaust three persisted attempts across restarts', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  await h.store.update('oc_test', 'm1', { retiredCardId: 'offline-card' });
  const patch = h.feishu.patch.bind(h.feishu); let attempts = 0;
  h.feishu.patch = async (id, card) => {
    if (id === 'offline-card') { attempts++; throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }); }
    return patch(id, card);
  };
  await h.bridge.retireCard(h.store.binding('oc_test', 'm1'));
  await h.bridge.tick(); assert.equal(attempts, 1);
  assert.equal(h.store.binding('oc_test', 'm1').retiredCardAttempts, 1);
  await h.restart(); assert.equal(attempts, 2);
  await h.restart(); assert.equal(attempts, 3);
  assert.equal(h.bridge.store.binding('oc_test', 'm1').retiredCardId, undefined);
  await h.restart(); h.advance(60000); await h.bridge.tick(); assert.equal(attempts, 3);
  assert.equal(h.errors.filter(line => line.startsWith('card_retirement_failed ')).length, 3);
});

test('retirement ignores a previous binding generation', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  const old = h.store.binding('oc_test', 'm1');
  await h.store.update('oc_test', 'm1', { generation: 'replacement', retiredCardId: 'stale-card' });
  const before = h.feishu.calls.length;
  await h.bridge.retireCard(old);
  assert.equal(h.feishu.calls.length, before);
  assert.equal(h.store.binding('oc_test', 'm1').retiredCardAttempts, undefined);
});

test('Feishu errors retain API rejection and transport exception details for retirement logs', async () => {
  const edge = new Feishu({ client: {}, ws: { close() {} } });
  await assert.rejects(edge.api(async () => ({ code: 230099, msg: 'Invalid card payload' })),
    error => error.code === '230099' && error.detail === 'Invalid card payload');
  await assert.rejects(edge.api(async () => { throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }); }),
    error => error.code === 'ECONNRESET' && error.detail === 'socket reset');
  await assert.rejects(edge.api(async () => { throw Object.assign(new Error('HTTP rejection'), {
    response: { status: 400, data: { code: 230031, msg: 'Message expired' } },
  }); }), error => error.code === '230031' && error.detail === 'Message expired');
});
