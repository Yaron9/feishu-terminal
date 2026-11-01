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

test('idle or done output missed during restart, reconnect or between polls flushes after stability', async t => {
  for (const mode of ['restart', 'reconnect', 'missed-working']) {
    const h = await harness(t); await h.bridge.handle(message('pwd')); await h.subscribed();
    if (mode === 'reconnect') { h.fake.disconnectSubscribers(); await eventually(() => h.fake.subscribers.size === 0); }
    Object.assign(h.fake.panes.get('w1:p1'), { agent: 'codex', agent_status: mode === 'restart' ? 'done' : 'idle', text: '$ completed', visible: '$ completed' });
    if (mode === 'restart') await h.restart();
    if (mode === 'reconnect') await h.subscribed();
    await h.bridge.tick(); assert.equal(texts(h).length, 0);
    h.advance(1499); await h.bridge.tick(); assert.equal(texts(h).length, 0);
    h.advance(1); await h.bridge.tick(); assert.equal(texts(h).at(-1)?.content, 'completed');
    h.advance(2000); await h.bridge.tick(); assert.equal(texts(h).length, 1);
  }
});

test('partly delivered output resumes fixed chunks and UUIDs across transcript growth and restart', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  const first = 'a'.repeat(12000), second = 'b'.repeat(1000);
  h.fake.output('w1:p1', '$ ' + first + second);
  await h.bridge.tick(); h.advance(1600);
  const reply = h.feishu.reply.bind(h.feishu); let failedUuid, fail = true;
  h.feishu.reply = async (topic, content, type, uuid) => {
    if (type === 'text' && content === second && fail) { fail = false; failedUuid = uuid; throw new Error('ambiguous delivery'); }
    return reply(topic, content, type, uuid);
  };
  await h.bridge.tick();
  assert.equal(texts(h).filter(c => c.content === first).length, 1);
  h.fake.output('w1:p1', '$ ' + first + second + 'tail'); await h.restart();
  await h.bridge.tick(); h.advance(1600); await h.bridge.tick(); h.advance(1600); await h.bridge.tick();
  assert.equal(texts(h).filter(c => c.content === first).length, 1);
  assert.equal(texts(h).find(c => c.content === second)?.uuid, failedUuid);
  assert.equal(texts(h).map(c => c.content).join(''), first + second + 'tail');
});

test('slow topic output cannot block another topic input; callback claims queued input before returning', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await h.bridge.handle(message('date', 'root2'));
  await h.bridge.tick(); h.advance(1000); h.fake.output('w1:p1', '$ slow');
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  h.feishu.patch = async () => { started(); await blocked; };
  const tick = h.bridge.tick(); await entered;
  try {
    const done = h.bridge.handle(message('independent', 'b-input', 'root2'));
    await eventually(() => writes(h).some(c => c.params.text === 'independent'), 'other topic input while output blocked');
    await done;
    await h.feishu.deliver(message('queued', 'queued', 'm1'));
    const { Store } = await import('../src/store.js');
    const disk = await new Store(h.store.file).load();
    assert.equal(await disk.claim(['message:queued']), false);
  } finally { release(); await tick; }
});

test('same-topic input stays ordered while a slow topic does not block another', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await h.bridge.handle(message('date', 'root2'));
  h.bridge.herdr.timeoutMs = 3000;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  // Delay the external socket response, not the bridge or store.
  h.fake.hold('pane.send_text', () => { started(); return gate; });
  const first = h.bridge.handle(message('first', 'first', 'm1')); await entered;
  const second = h.bridge.handle(message('second', 'second', 'm1'));
  try {
    await h.feishu.deliver(message('third', 'third', 'm1'));
    const { Store } = await import('../src/store.js'); const disk = await new Store(h.store.file).load();
    assert.equal(await disk.claim(['message:third']), false);
    const other = h.bridge.handle(message('other', 'other', 'root2'));
    await eventually(() => writes(h).some(c => c.params.text === 'other'), 'other topic while input blocked'); await other;
    assert.ok(!writes(h).some(c => c.params.text === 'second'));
  } finally { release(); await first; await second; await h.drain(); }
  assert.deepEqual(writes(h).filter(c => ['first', 'second', 'third'].includes(c.params.text)).map(c => c.params.text), ['first', 'second', 'third']);
});
