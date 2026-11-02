import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, message, pickerEvent, outputReplies } from './helpers.js';

const writes = fake => fake.calls.filter(c => ['pane.send_text', 'pane.send_keys', 'agent.prompt'].includes(c.method));
const records = outputReplies;
const cards = edge => edge.calls.filter(c => (c.type === 'patch' || c.msgType === 'interactive') && !(c.card ?? c.content)?.schema);

test('new post creates workspace/pane, binds original root, and sends first shell input in order', async t => {
  const h = await harness(t);
  await h.bridge.handle(message('echo hello'));
  const binding = h.store.binding('oc_test', 'm1'); assert.equal(binding.paneId, 'w1:p1');
  const create = h.fake.calls.find(c => c.method === 'workspace.create');
  assert.deepEqual(create.params, { cwd: '/tmp', focus: false, label: 'feishu' });
  assert.deepEqual(writes(h.fake).map(c => [c.method, c.params]), [
    ['pane.send_text', { pane_id: binding.paneId, text: 'echo hello' }],
    ['pane.send_keys', { pane_id: binding.paneId, keys: ['enter'] }],
  ]);
  await h.bridge.handle(message('pwd', 'm2'));
  assert.equal(h.fake.calls.filter(c => c.method === 'workspace.create').length, 1);
  assert.equal(h.fake.calls.filter(c => c.method === 'tab.create').length, 1);
  assert.equal(h.audits.find(a => a.action === 'first_input').pane, 'w1:p1');
  assert.ok(!JSON.stringify(h.audits).includes('echo hello'));
});

test('bound shell slash commands/raw remain verbatim; validation blocks every invalid key batch', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  await h.bridge.handle(message('/compact', 'm2', 'm1'));
  await h.bridge.handle(message('/help', 'm3', 'm1'));
  await h.bridge.handle(message('/t raw  spaces\n ', 'm4', 'm1'));
  assert.deepEqual(writes(h.fake).filter(c => c.method === 'pane.send_text').map(c => c.params.text), ['pwd', '/compact', '/help', ' spaces\n ']);
  assert.equal(writes(h.fake).filter(c => c.method === 'pane.send_keys').length, 3);
  const before = writes(h.fake).length;
  for (const [i, text] of ['/t k enter invalid', '/t k ' + Array(9).fill('enter').join(' '), '/t k'].entries()) await h.bridge.handle(message(text, `bad${i}`, 'm1'));
  assert.equal(writes(h.fake).length, before);
  await h.bridge.handle(message('/t k ctrl+c shift+tab', 'valid', 'm1'));
  assert.deepEqual(writes(h.fake).at(-1).params.keys, ['ctrl+c', 'shift+tab']);
});

test('recognized agent uses agent.prompt; blocked prompt displays one live card without shell fallback', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  h.fake.status('w1:p1', 'idle');
  await h.bridge.handle(message('/compact\n literal ', 'm2', 'm1'));
  assert.deepEqual(writes(h.fake).at(-1), { id: writes(h.fake).at(-1).id, method: 'agent.prompt', params: { target: 'w1:p1', text: '/compact\n literal ' } });
  h.fake.status('w1:p1', 'blocked'); h.fake.output('w1:p1', 'Allow command? [y/n]');
  await h.bridge.handle(message('do next', 'm3', 'm1'));
  assert.equal(writes(h.fake).at(-1).method, 'agent.prompt');
  const card = cards(h.feishu).at(-1).content;
  assert.equal(card.header.template, 'orange'); assert.equal(card.elements.slice(1).flatMap(e => e.actions).length, 9);
  assert.ok(!records(h.feishu).some(c => String(c.content).includes('fixture error')));
});

test('live card edits are throttled to 1 Hz and quiet shell posts only new output; polling works without events', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await h.subscribed();
  h.fake.output('w1:p1', '$ pwd\n/tmp\n$ '); await h.drain(); await h.bridge.tick();
  assert.equal(cards(h.feishu).length, 1);
  h.advance(300); h.fake.output('w1:p1', '$ pwd\n/tmp\n$ new'); await h.drain(); await h.bridge.tick();
  assert.equal(cards(h.feishu).length, 1);
  h.advance(700); await h.bridge.tick(); assert.equal(cards(h.feishu).length, 2);
  h.advance(800); await h.bridge.tick();
  const initialOutput = records(h.feishu).map(c => c.content).join(''); assert.equal(initialOutput, 'pwd\n/tmp\n$ new');
  // No event emitted: fallback polling must still discover and settle changes.
  h.fake.panes.get('w1:p1').text += '\nonly polling'; h.fake.panes.get('w1:p1').visible += '\nonly polling';
  h.advance(1000); await h.bridge.tick(); h.advance(1500); await h.bridge.tick();
  assert.equal(records(h.feishu).at(-1).content, '\nonly polling');
  const count = records(h.feishu).length; h.advance(2000); await h.bridge.tick(); assert.equal(records(h.feishu).length, count);
  assert.ok(cards(h.feishu).slice(1).every((c, i) => c.time - cards(h.feishu)[i].time >= 1000));
  assert.ok(cards(h.feishu).filter(c => c.type === 'patch').every(c => c.id === cards(h.feishu)[0].id));
});

test('fallback agent output waits through working and flushes working -> done as a bounded reply card', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await h.subscribed();
  h.fake.status('w1:p1', 'working'); h.fake.output('w1:p1', '$ ' + '中文🙂'.repeat(6000));
  await h.drain(); await h.bridge.tick(); h.advance(5000); await h.bridge.tick(); assert.equal(records(h.feishu).length, 0);
  h.fake.status('w1:p1', 'done'); await h.drain(); await h.bridge.tick();
  assert.equal(records(h.feishu).length, 1);
  assert.equal(records(h.feishu)[0].content, '中文🙂'.repeat(500));
  assert.equal(records(h.feishu)[0].card.header.title.content, '🤖 Codex');
  assert.match(records(h.feishu)[0].card.body.elements[0].content, /仅显示末尾/);
  assert.ok(Buffer.byteLength(JSON.stringify(records(h.feishu)[0].card)) < 28000);
  const count = records(h.feishu).length; h.advance(2000); await h.bridge.tick(); assert.equal(records(h.feishu).length, count);
});

test('blocked card buttons validate ACL, card identity and nonce, consume nonce, reject stale and cross-topic clicks', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await h.subscribed();
  h.fake.status('w1:p1', 'blocked'); await h.drain(); await h.bridge.tick();
  const binding = h.store.binding('oc_test', 'm1');
  const click = { kind: 'button', eventId: 'click1', chatId: 'oc_test', openId: 'ou_test', topicId: 'm1',
    messageId: binding.cardId, nonce: binding.nonce, key: 'enter' };
  const count = writes(h.fake).length;
  await h.bridge.handle({ ...click, eventId: 'foreign', messageId: 'other-card' });
  await h.bridge.handle({ ...click, eventId: 'stale', nonce: 'stale' });
  await h.bridge.handle({ ...click, eventId: 'unauth', openId: 'ou_bad' });
  await h.bridge.handle({ ...click, eventId: 'bad-key', key: 'exec' });
  assert.equal(writes(h.fake).length, count);
  await h.bridge.handle(click); assert.equal(writes(h.fake).length, count + 1);
  assert.deepEqual(writes(h.fake).at(-1).params.keys, ['enter']);
  await h.bridge.handle(click); await h.bridge.handle({ ...click, eventId: 'replay-new-id' });
  assert.equal(writes(h.fake).length, count + 1);
  const restored = await h.restart();
  await h.bridge.handle({ ...click, eventId: 'restart-replay' }); assert.equal(writes(h.fake).length, count + 1);
  assert.notEqual(restored.binding('oc_test', 'm1').nonce, click.nonce);
});

test('message/event dedupe persists across restart and ACL refuses once without touching herdr', async t => {
  const h = await harness(t);
  await h.bridge.handle(message('bad', 'denied', 'denied', { openId: 'ou_bad' }));
  await h.bridge.handle(message('bad again', 'denied2', 'denied2', { openId: 'ou_bad' }));
  await h.bridge.handle(message('wrong group', 'denied3', 'denied3', { chatId: 'oc_other' }));
  assert.equal(h.fake.calls.length, 0); assert.equal(h.feishu.calls.length, 2);
  await Promise.all(Array.from({ length: 4 }, () => h.bridge.handle(message('pwd'))));
  assert.equal(writes(h.fake).length, 2);
  const restored = await h.restart(); assert.equal(restored.binding('oc_test', 'm1').paneId, 'w1:p1');
  await h.bridge.handle(message('pwd', 'm1', 'm1', { eventId: 'new-delivery' }));
  await h.bridge.handle(message('pwd', 'new-message', 'm1', { eventId: 'e-m1' }));
  assert.equal(writes(h.fake).length, 2);
  await h.bridge.handle(message('date', 'm2', 'm1')); assert.equal(writes(h.fake).length, 4);
  await h.bridge.handle(message('echo bot', 'bot', 'm1', { senderType: 'app' })); assert.equal(writes(h.fake).length, 4);
});

test('Refresh consumes nonce and schedules an unchanged blocked card after the throttle window', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd')); await h.subscribed();
  h.fake.status('w1:p1', 'blocked'); await h.drain(); await h.bridge.tick();
  const before = h.store.binding('oc_test', 'm1'); h.advance(100);
  await h.bridge.handle({ kind: 'button', eventId: 'refresh1', chatId: 'oc_test', openId: 'ou_test', topicId: 'm1', messageId: before.cardId, nonce: before.nonce, key: 'refresh' });
  assert.equal(cards(h.feishu).length, 1); assert.notEqual(h.store.binding('oc_test', 'm1').nonce, before.nonce);
  h.advance(900); await h.bridge.tick(); assert.equal(cards(h.feishu).length, 2);
  const card = cards(h.feishu).at(-1).card;
  assert.equal(card.elements[1].actions[0].value.nonce, h.store.binding('oc_test', 'm1').nonce);
});

test('/t open binds desktop pane with a fresh topic; picker includes agent status; close offers unbind and --kill destroys', async t => {
  const h = await harness(t); const desktop = h.fake.create(); desktop.agent = 'claude'; desktop.agent_status = 'idle';
  await h.bridge.handle(message('/t ls', 'list')); assert.match(JSON.stringify(cards(h.feishu).at(-1).content), /claude 空闲.*桌面.*未绑定.*w1:p1/);
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const binding = h.store.forPane('w1:p1'); assert.ok(binding.topicId.startsWith('bot-'));
  assert.equal(writes(h.fake).length, 0);
  await h.bridge.handle(message('/t open w1:p1', 'reopen')); assert.equal(h.store.list().length, 1);
  await h.bridge.handle(message('/t close', 'close', binding.topicId));
  assert.equal(h.store.list().length, 1);
  await h.bridge.handle(pickerEvent(h, 'unbind'));
  assert.equal(h.store.list().length, 0); assert.ok(h.fake.panes.has('w1:p1'));
  await h.bridge.handle(message('old topic', 'old', binding.topicId)); assert.equal(h.store.list().length, 0);
  await h.bridge.handle(message('/t open w1:p1', 'open2'));
  await h.bridge.handle(message('/t close --kill', 'kill', h.store.forPane('w1:p1').topicId));
  assert.equal(h.store.list().length, 0); assert.ok(!h.fake.panes.has('w1:p1'));
});

test('ambiguous failed terminal write is not retried or followed by Enter', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  h.fake.drop('pane.send_text');
  await h.bridge.handle(message('danger', 'm2', 'm1'));
  assert.equal(writes(h.fake).length, 3); assert.equal(writes(h.fake).at(-1).method, 'pane.send_text');
  await h.bridge.handle(message('danger', 'm2', 'm1'));
  assert.equal(writes(h.fake).length, 3);
  assert.ok(records(h.feishu).at(-1).content.includes('not retried'));
});
