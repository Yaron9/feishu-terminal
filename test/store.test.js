import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, auditRecord, appendAudit } from '../src/store.js';

async function fixture(t, options) {
  const dir = await mkdtemp(new URL('../.test-store-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: await new Store(join(dir, 'state.json'), options).load() };
}

test('unbound picker nonces survive restart, consume atomically once and cannot consume a replacement version', async t => {
  const { store } = await fixture(t);
  const card = { messageId: 'picker', chatId: 'chat', topicId: 'topic', nonce: 'first', createdAt: 0, entries: [] };
  await store.saveActionCard(card, 0);
  const restored = await new Store(store.file).load();
  assert.deepEqual(restored.actionCard('picker'), card);
  const claims = await Promise.all([restored.consumeActionCard(card), restored.consumeActionCard(card)]);
  assert.deepEqual(claims, [true, false]);
  await restored.saveActionCard({ ...card, nonce: 'second' }, 1);
  assert.equal(await restored.consumeActionCard(card), false);
  assert.equal((await new Store(store.file).load()).actionCard('picker').nonce, 'second');
  await restored.saveActionCard({ ...card, messageId: 'new' }, 600000);
  assert.equal(restored.actionCard('picker'), undefined);
});
test('bindings, nonce, card and transcript survive atomic restart; uniqueness is enforced', async t => {
  const { dir, store } = await fixture(t);
  await store.bind({ chatId: 'oc_a', topicId: 'm1', paneId: 'w1:p1' });
  await store.update('oc_a', 'm1', { cardId: 'c1', lastTranscript: 'hello' });
  const b = store.binding('oc_a', 'm1'); assert.ok(b.nonce);
  const restored = await new Store(store.file).load(); assert.deepEqual(restored.list(), store.list());
  b.paneId = 'bad'; assert.equal(store.binding('oc_a', 'm1').paneId, 'w1:p1');
  await assert.rejects(store.bind({ chatId: 'oc_a', topicId: 'm2', paneId: 'w1:p1' }));
  await assert.rejects(store.bind({ chatId: 'oc_a', topicId: 'm1', paneId: 'w1:p2' }));
  assert.deepEqual((await readdir(dir)).filter(f => f.endsWith('.tmp')), []);
  await store.unbind('oc_a', 'm1'); assert.deepEqual(store.list(), []);
});

test('pre-ft7 and ft7 version-1 snapshots load unchanged with optional recovery fields absent', async t => {
  const { store } = await fixture(t);
  const binding = { chatId: 'oc_a', topicId: 'topic', paneId: 'w1:p1',
    identity: { terminalId: 'terminal', workspaceId: 'w1', tabId: 'w1:t1' },
    nonce: 'screen-nonce', cardId: 'screen', lastTranscript: 'checkpoint',
    pendingCard: { nonce: 'pending', targetId: 'screen', uuid: 'retry-id', createdAt: 1, card: { elements: [] } } };
  const legacy = { version: 1, bindings: [binding], seen: ['event:old'] };
  const ft7 = { ...legacy, bindings: [{ ...binding, generation: 'ft7-generation', allowDesktop: true }],
    createdTerminals: ['terminal'], actionCards: [{ messageId: 'picker', chatId: 'oc_a', topicId: 'list',
      kind: 'list', createdAt: 1, nonce: 'picker-nonce', entries: [{ paneId: 'w1:p1', bindingTopic: 'topic', generation: 'ft7-generation' }] }] };
  for (const snapshot of [legacy, ft7]) {
    await writeFile(store.file, JSON.stringify(snapshot));
    const restored = await new Store(store.file).load();
    assert.deepEqual(restored.data, snapshot);
    assert.equal(restored.binding('oc_a', 'topic').retiredCardId, undefined);
    assert.equal(restored.binding('oc_a', 'topic').pendingCard.previousCardId, undefined);
    await restored.claim(['event:new']);
    assert.deepEqual((await new Store(store.file).load()).list(), snapshot.bindings);
    if (snapshot.actionCards) assert.deepEqual(restored.actionCard('picker'), snapshot.actionCards[0]);
  }
});
test('concurrent claims are durable, bounded, and dedupe both event and message IDs', async t => {
  const { store } = await fixture(t, { dedupeLimit: 4 });
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claim(['m1', 'e1'])));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await new Store(store.file).load().then(s => s.claim(['m1', 'e2'])), false);
  await store.claim(['m2', 'e2']); await store.claim(['m3', 'e3']);
  assert.equal(store.data.seen.length, 4); assert.equal(await store.claim(['m1']), true);
  assert.equal(await store.claim([]), false);
});
test('corrupt state fails closed and audit never contains typed input', async t => {
  const { dir, store } = await fixture(t);
  await writeFile(store.file, '{broken'); await assert.rejects(new Store(store.file).load());
  await writeFile(store.file, JSON.stringify({ version: 2, bindings: [], seen: [] }));
  await assert.rejects(new Store(store.file).load());
  const file = join(dir, 'audit.jsonl');
  const record = auditRecord({ openId: 'ou_a', topicId: 'm1', paneId: 'w1:p1', action: 'input', text: 'password-secret-中文' });
  await appendAudit(file, record);
  const log = await readFile(file, 'utf8');
  assert.ok(!log.includes('password-secret')); assert.equal(JSON.parse(log).hash.length, 64);
  assert.equal(record.length, Buffer.byteLength('password-secret-中文'));
});
