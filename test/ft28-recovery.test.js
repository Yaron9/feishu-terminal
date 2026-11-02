import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { legacyHarness, message } from './helpers.js';
import { coreHarness } from './ft25-helper.js';
import { HerdrClient } from '../src/herdr-client.js';

for (const code of ['unavailable', 'ECONNREFUSED', 'connection_closed', 'timeout', 'backend_unreachable', 'startup_not_ready', 'identity_mismatch']) {
  test(`startup verification ${code} retries without freezing or notifying`, async t => {
    const h = await legacyHarness(t); await h.bridge.handle(message('pwd'));
    const b = h.store.list()[0], before = h.feishu.calls.length;
    h.fake.fail('pane.get', code);
    const restored = await h.restart();
    assert.equal(Boolean(restored.list()[0].frozen), false);
    assert.equal(h.bridge.state(b).verified, false);
    assert.equal(h.feishu.calls.length, before);
    const count = h.fake.calls.length;
    await h.bridge.tick(); assert.equal(h.fake.calls.length, count, 'backoff prevents immediate requests');
    h.advance(2000); await h.bridge.tick();
    assert.equal(h.bridge.state(b).verified, true);
    assert.equal(restored.list()[0].generation, b.generation);
    assert.ok(h.errors.some(e => e.includes(`"code":"${code}"`) && e.includes('fixture error')));
  });
}

for (const mode of ['missing', 'terminal', 'workspace', 'tab']) {
  test(`successful backend evidence of ${mode} freezes and cannot auto-heal`, async t => {
    const h = await legacyHarness(t); await h.bridge.handle(message('pwd'));
    if (mode === 'missing') h.fake.panes.clear();
    else h.fake.panes.get('w1:p1')[{ terminal: 'terminal_id', workspace: 'workspace_id', tab: 'tab_id' }[mode]] = 'changed';
    await h.restart(); assert.equal(h.bridge.store.list()[0].frozen, true);
    h.advance(2000); await h.bridge.tick();
    assert.equal(h.bridge.store.list()[0].frozen, true);
    assert.ok(!JSON.stringify(h.feishu.calls).includes('已恢复同步'));
    if (mode === 'missing') assert.ok(h.fake.calls.some(c => c.method === 'pane.list'));
  });
}

test('matching frozen binding heals once with a new generation, fresh card and retired controls', async t => {
  const h = await legacyHarness(t); await h.bridge.handle(message('pwd'));
  h.fake.status('w1:p1', 'blocked'); await h.bridge.tick();
  const before = h.store.list()[0];
  await h.store.update(before.chatId, before.topicId, { frozen: true });
  h.advance(2000); await h.bridge.tick();
  const after = h.store.list()[0];
  assert.equal(after.frozen, false); assert.notEqual(after.generation, before.generation);
  assert.notEqual(after.nonce, before.nonce); assert.notEqual(after.cardId, before.cardId);
  assert.equal(after.topicId, before.topicId); assert.deepEqual(after.identity, before.identity);
  assert.equal(after.lastTranscript, before.lastTranscript);
  assert.ok(h.feishu.calls.some(c => c.type === 'patch' && c.id === before.cardId));
  h.advance(2000); await h.bridge.tick(); await h.restart();
  const notes = h.feishu.calls.filter(c => JSON.stringify(c.content ?? '').includes('已恢复同步'));
  assert.equal(notes.length, 1); assert.match(JSON.stringify(notes[0].content), /grey/);
  assert.equal(h.store.list().length, 1);
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
});

test('restart heals a matching frozen binding in its existing topic', async t => {
  const h = await legacyHarness(t); await h.bridge.handle(message('pwd'));
  const b = h.store.list()[0]; await h.store.update(b.chatId, b.topicId, { frozen: true });
  const restored = await h.restart(), current = restored.list()[0];
  assert.equal(current.frozen, false); assert.notEqual(current.generation, b.generation);
  assert.equal(current.topicId, b.topicId); assert.equal(current.recoveryPending, null);
  assert.equal(h.feishu.calls.filter(c => JSON.stringify(c.content ?? '').includes('已恢复同步')).length, 1);
});

for (const mode of ['match', 'core', 'address', 'created']) {
  test(`hc frozen identity ${mode} recovery checks core/address/created`, async t => {
    const h = await coreHarness(t), term = h.hc.create();
    await h.bridge.handle(message('/t open hc:t1', 'open'));
    const b = h.store.list()[0]; await h.store.update(b.chatId, b.topicId, { frozen: true });
    if (mode === 'core') h.hc.coreId('replacement');
    if (mode === 'address') term.address = 't2';
    if (mode === 'created') term.created_ms++;
    await h.poll();
    assert.equal(h.store.list()[0].frozen, mode !== 'match');
    assert.equal(h.feishu.calls.filter(c => JSON.stringify(c.content ?? '').includes('已恢复同步')).length, mode === 'match' ? 1 : 0);
  });
}

test('outage stays silent for two minutes, reports once, and resets after recovery', async t => {
  const h = await legacyHarness(t); await h.bridge.handle(message('pwd'));
  const b = h.store.list()[0], get = h.bridge.backend.get.bind(h.bridge.backend);
  let offline = true;
  h.bridge.backend.get = (...args) => offline ? Promise.reject(Object.assign(new Error('not ready'), { code: 'unavailable' })) : get(...args);
  const before = h.feishu.calls.length;
  await h.bridge.verify(b).catch(() => {});
  h.advance(120000); await h.bridge.tick(); assert.equal(h.feishu.calls.length, before);
  h.advance(1001); await h.bridge.tick();
  h.advance(60000); await h.bridge.tick();
  assert.equal(h.feishu.calls.filter(c => c.content === '暂时连不上终端服务，正在重试').length, 1);
  assert.equal(Boolean(h.store.list()[0].frozen), false);
  offline = false; h.advance(30000); await h.bridge.tick();
  assert.equal(h.bridge.state(b).verified, true);
  assert.equal(h.bridge.state(b).outageSince, null);
});

for (const method of ['pane.read', 'pane.list']) test(`${method} transport failure backs off without freezing`, async t => {
  const h = await legacyHarness(t); await h.bridge.handle(message('pwd'));
  const b = h.store.list()[0]; h.fake.fail(method, 'unavailable');
  await h.bridge.tick();
  assert.equal(Boolean(h.store.list()[0].frozen), false);
  assert.equal(h.bridge.state(b).verified, false);
  assert.equal(h.bridge.state(b).outageSince, h.now());
  h.advance(2000); await h.bridge.tick(); assert.equal(h.bridge.state(b).verified, true);
});

test('a persistent read outage reaches the two-minute notice even while identity checks succeed', async t => {
  const h = await legacyHarness(t); await h.bridge.handle(message('pwd'));
  const read = h.bridge.backend.read.bind(h.bridge.backend);
  h.bridge.backend.read = () => Promise.reject(Object.assign(new Error('read unavailable'), { code: 'unavailable' }));
  await h.bridge.tick();
  for (let i = 0; i < 5; i++) { h.advance(30000); await h.bridge.tick(); }
  assert.equal(h.feishu.calls.filter(c => c.content === '暂时连不上终端服务，正在重试').length, 1);
  assert.equal(Boolean(h.store.list()[0].frozen), false);
  h.bridge.backend.read = read; h.advance(30000); await h.bridge.tick();
  assert.equal(h.bridge.state(h.store.list()[0]).outageSince, null);
});

test('herdr startup fan-out bounds in-flight requests and writes only after connect', async t => {
  let active = 0, peak = 0, calls = 0;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.once('data', input => {
      const { id } = JSON.parse(input); active++; peak = Math.max(peak, active); calls++;
      setTimeout(() => { active--; socket.end(JSON.stringify({ id, result: {} }) + '\n'); }, 5);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new HerdrClient({ endpoint: { host: '127.0.0.1', port: server.address().port } });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await Promise.all(Array.from({ length: 32 }, () => client.request('ping')));
  assert.equal(calls, 32); assert.equal(peak, 4);
});
