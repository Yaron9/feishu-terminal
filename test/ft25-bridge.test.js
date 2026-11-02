import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { coreHarness } from './ft25-helper.js';
import { message } from './helpers.js';
import { model } from './fixtures/ft17-menus.js';

test('Feishu creates hc topic, sends exactly once, preserves ambiguous claims/raw, closes with terminal.kill', async t => {
  const h = await coreHarness(t);
  const event = message('claude', 'new'); await h.bridge.handle(event); await h.bridge.handle(event);
  let b = h.store.list()[0]; assert.equal(b.paneId, 'hc:t1');
  assert.equal(h.hc.calls.filter(c => c.method === 'terminal.run').length, 1);
  assert.equal(h.hc.calls.filter(c => c.method === 'terminal.send').length, 1);
  assert.equal(h.hc.calls.filter(c => c.method === 'terminal.keys').length, 0);
  await h.bridge.handle(message('/t raw 中文\nRAW + !', 'raw', b.topicId));
  assert.deepEqual(h.hc.raw, ['\x1b[200~中文\nRAW + !\x1b[201~']);
  h.hc.drop('terminal.send'); const ambiguous = message('lost', 'lost', b.topicId);
  await h.bridge.handle(ambiguous); await h.bridge.handle(ambiguous);
  assert.equal(h.store.list()[0].needs_check, true);
  await h.bridge.handle(message('refused', 'refused', b.topicId));
  assert.equal(h.hc.calls.filter(c => c.method === 'terminal.send').length, 2);
  await h.bridge.handle(message('/t close --kill', 'close', b.topicId));
  assert.equal(h.store.list().length, 0); assert.equal(h.hc.terminals.get('t1').state, 'finished');
  assert.equal(h.hc.calls.filter(c => c.method === 'terminal.kill').length, 1);
});

test('hc menus, transcript turns/background tasks and live topic titles share existing cards', async t => {
  const h = await coreHarness(t);
  const term = h.hc.create({ title: 'Core title', foreground: { pid: 202, name: 'claude', cwd: '/tmp/project', argv: ['claude'] }, output: model });
  await h.process(202, 200, 'hc:t1');
  await h.bridge.handle(message('/t open hc:t1', 'open'));
  await h.poll(); let b = h.store.forPane('hc:t1');
  assert.equal(b.claudeSessionId, 'same'); assert.equal(b.topicRoot.text, 'Core title'); assert.ok(b.menuCardId);
  const click = { kind: 'button', eventId: randomUUID(), chatId: b.chatId, topicId: b.topicId, openId: 'ou_test',
    messageId: b.menuCardId, nonce: b.menuNonce, key: 'menu:select:1' };
  await h.bridge.handle(click); await h.bridge.handle({ ...click, eventId: randomUUID() });
  assert.deepEqual(h.hc.calls.filter(c => c.method === 'terminal.keys').map(c => c.params.keys), [['down', 'enter']]);
  term.output = '❯ '; await h.records([
    { type: 'user', uuid: 'u1', message: { content: 'desktop' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'sleep 60', run_in_background: true } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Command running in background with ID: job1\nOutput is being written to: /tmp/job1' }] } },
  ]); await h.poll(); b = h.store.forPane('hc:t1');
  assert.equal(b.turn.settled, false); assert.ok(b.cardId); assert.equal(b.turn.background.running.length, 1);
  const cardId = b.cardId;
  await h.records([{ type: 'assistant', message: { content: 'more answer' } }, { type: 'system', subtype: 'turn_duration' }]);
  await h.poll(); b = h.store.forPane('hc:t1'); assert.equal(b.turn.settled, true); assert.equal(b.cardId, cardId);
  term.title = 'Updated title'; await h.poll(); h.advance(12000); await h.bridge.tick();
  assert.equal(h.store.forPane('hc:t1').topicRoot.publishedTitle, 'Updated title');
});

test('legacy raw-ID state loads without migration while hc picker labels both backends', async t => {
  const h = await coreHarness(t), old = h.herdr.create(); h.hc.create();
  await h.bridge.handle(message(`/t open ${old.pane_id}`, 'old'));
  const before = h.store.forPane(old.pane_id);
  const restored = await new Store(h.store.file).load(); assert.deepEqual(restored.forPane(old.pane_id), before);
  await h.bridge.handle(message('/t ls', 'list'));
  const card = h.feishu.calls.findLast(c => c.content?.header?.title?.content.includes('终端'))?.content;
  assert.match(JSON.stringify(h.feishu.calls), /herdr-core/); assert.match(JSON.stringify(h.feishu.calls), /旧 herdr/);
  assert.ok(card);
});

test('hc bridge remains usable while herdr is down; hc outage cannot freeze legacy binding', async t => {
  const h = await coreHarness(t), old = h.herdr.create();
  await h.bridge.handle(message(`/t open ${old.pane_id}`, 'old'));
  h.hc.fail('terminal.list', 'unavailable'); await h.poll();
  assert.equal(Boolean(h.store.forPane(old.pane_id).frozen), false);
  h.herdr.fail('pane.list', 'unavailable'); await h.bridge.handle(message('pwd', 'new'));
  assert.ok(h.store.forPane('hc:t1'));
  assert.ok(h.errors.includes('backend_unreachable hc')); assert.ok(h.errors.includes('backend_unreachable herdr'));
});
