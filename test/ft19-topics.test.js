import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, legacyHarness, message } from './helpers.js';
import { topicCard, topicTitle } from '../src/topics.js';
import { Feishu } from '../src/feishu.js';

const inputs = h => h.fake.calls.filter(c => ['pane.send_text', 'pane.send_keys', 'agent.prompt'].includes(c.method));
const rootPatches = h => h.feishu.calls.filter(c => c.type === 'patch' && c.id === h.bridge.store.forPane('w1:p1').topicId);
async function opened(t) {
  const h = await harness(t), pane = h.fake.create();
  Object.assign(pane, { terminal_title_stripped: 'Session A', cwd: '/home/me/project', agent: 'claude' });
  await h.bridge.handle(message('/t open w1:p1'));
  return { h, pane };
}

test('root card shows the session title, identity header and grey agent/directory/pane line', () => {
  const pane = { terminal_title_stripped: '✻ Session A', cwd: '/home/me/project', agent: 'claude', pane_id: 'w2:p1' };
  const card = topicCard(pane, topicTitle(pane), '/home/me');
  assert.equal(card.header.title.content, 'Session A');
  assert.equal(card.config.update_multi, true);
  assert.deepEqual(card.body.elements, [
    { tag: 'markdown', content: "<font color='grey'>会话：Session A · 编号未知</font>" },
    { tag: 'markdown', content: "<font color='grey'>Claude · ~/project · w2:p1</font>" },
  ]);
  assert.equal(topicTitle({ cwd: '/a/project' }), 'project');
  assert.equal(topicTitle({}), '终端');
  assert.equal(topicTitle({ terminal_title_stripped: '⠋ ✻' }), '终端');
  assert.equal(topicTitle({ terminal_title_stripped: 'C++' }), 'C++');
});

test('Feishu send chooses interactive for card roots and text for ordinary messages', async () => {
  const calls = [], client = { im: { message: { create: async args => { calls.push(args); return { data: { message_id: 'id' } }; } } } };
  const api = new Feishu({ client, ws: {} });
  const card = topicCard({ pane_id: 'w1:p1' });
  await api.send('chat', card, 'uuid-card'); api.nextSend = 0;
  await api.send('chat', 'text', 'uuid-text');
  assert.equal(calls[0].data.msg_type, 'interactive');
  assert.deepEqual(JSON.parse(calls[0].data.content), card);
  assert.equal(calls[0].data.uuid, 'uuid-card');
  assert.equal(calls[1].data.msg_type, 'text');
});

test('title must stay stable ten seconds; glyph changes do not reset it; one attempt per minute', async t => {
  const { h, pane } = await opened(t);
  await h.bridge.tick();
  pane.terminal_title_stripped = '✻ Session B'; h.advance(1000); await h.bridge.tick();
  h.advance(9000); pane.terminal_title_stripped = '✻ Session B'; await h.bridge.tick();
  assert.equal(rootPatches(h).length, 0);
  h.advance(1000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 1);
  assert.equal(rootPatches(h)[0].card.header.title.content, 'Session B');
  pane.terminal_title_stripped = 'Session C'; h.advance(1000); await h.bridge.tick();
  h.advance(59000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 2);
  assert.equal(rootPatches(h)[1].time - rootPatches(h)[0].time, 60000);
  pane.terminal_title_stripped = '✻ Session C'; h.advance(60000); await h.bridge.tick();
  assert.equal(rootPatches(h).length, 2);
});

test('a changing candidate restarts debounce and published title/rate budget survive restart', async t => {
  const { h, pane } = await opened(t);
  pane.terminal_title_stripped = 'B'; await h.bridge.tick();
  h.advance(9000); pane.terminal_title_stripped = 'C'; await h.bridge.tick();
  h.advance(9000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 0);
  h.advance(1000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 1);
  await h.restart(); await h.bridge.tick();
  assert.equal(h.bridge.store.forPane('w1:p1').topicRoot.publishedTitle, 'C');
  h.advance(10000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 1);
  pane.terminal_title_stripped = 'D'; h.advance(1000); await h.bridge.tick();
  h.advance(10000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 1);
  h.advance(39000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 2);
});

test('update-window errors stop quietly and persist across restart; known 14-day age avoids API', async t => {
  const { h, pane } = await opened(t), patch = h.feishu.patch.bind(h.feishu);
  let attempts = 0;
  h.feishu.patch = async (id, card) => {
    if (id === h.bridge.store.forPane('w1:p1').topicId) { attempts++; throw Object.assign(new Error(), { code: '230031' }); }
    return patch(id, card);
  };
  pane.terminal_title_stripped = 'B'; await h.bridge.tick(); h.advance(10000); await h.bridge.tick();
  assert.equal(attempts, 1); assert.equal(h.bridge.store.forPane('w1:p1').topicRoot.stopped, true);
  await h.restart(); h.advance(120000); pane.terminal_title_stripped = 'C'; await h.bridge.tick();
  h.advance(10000); await h.bridge.tick(); assert.equal(attempts, 1);
  assert.ok(!h.errors.includes('topic_title_update_failed'));
  const b = h.bridge.store.forPane('w1:p1');
  await h.bridge.store.update(b.chatId, b.topicId, { topicRoot: { ...b.topicRoot, stopped: false } });
  h.advance(14 * 86400000); await h.bridge.tick(); assert.equal(attempts, 1);
  assert.equal(h.bridge.store.forPane('w1:p1').topicRoot.stopped, true);
});

test('new user post binds its own topic and processes each input once across restart', async t => {
  const h = await harness(t), event = message('claude');
  await Promise.all([h.bridge.handle(event), h.bridge.handle({ ...event, eventId: 'duplicate' })]);
  const binding = h.store.forPane('w1:p1');
  assert.equal(binding.topicId, event.messageId);
  assert.equal(binding.topicRoot.type, 'user');
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
  assert.deepEqual(inputs(h).map(c => c.method), ['pane.send_text', 'pane.send_keys']);
  await h.restart();
  assert.equal(h.store.forPane('w1:p1').topicId, event.messageId);
  await h.bridge.handle(message('pwd', 'new-input', binding.topicId));
  assert.equal(inputs(h).length, 4);
  await h.bridge.handle(event); assert.equal(inputs(h).length, 4);
});

test('open and move create bot cards; moving preserves existing input and transcript state', async t => {
  const { h, pane } = await opened(t), old = h.store.forPane(pane.pane_id);
  pane.terminal_title_stripped = 'Current session';
  await h.bridge.handle(message('/t move', 'move', old.topicId));
  const roots = h.feishu.calls.filter(c => c.type === 'send');
  assert.equal(roots.length, 2); assert.equal(roots[0].text.header.title.content, 'Session A');
  assert.equal(roots[1].text.header.title.content, 'Current session');
  const current = h.store.forPane(pane.pane_id);
  assert.equal(current.topicRoot.publishedTitle, 'Current session');
  assert.notEqual(current.generation, old.generation); assert.equal(inputs(h).length, 0);
});

test('legacy text/user roots remain bound and untouched, and move creates a card', async t => {
  const h = await legacyHarness(t); await h.bridge.handle(message('pwd'));
  await h.store.update('oc_test', 'm1', { topicRoot: { text: '终端：legacy', createdAt: 0 } });
  const pane = h.fake.panes.get('w1:p1'); pane.terminal_title_stripped = 'Changed';
  await h.bridge.tick(); h.advance(120000); await h.bridge.tick();
  assert.ok(!h.feishu.calls.some(c => c.type === 'patch' && c.id === 'm1'));
  await h.bridge.handle(message('date', 'next', 'm1')); assert.equal(inputs(h).length, 4);
  await h.bridge.handle(message('/t move', 'move', 'm1'));
  assert.equal(h.store.forPane('w1:p1').topicRoot.type, 'interactive');
});


test('a title containing only changing status glyphs never replaces the published session name', async t => {
  const { h, pane } = await opened(t);
  pane.terminal_title_stripped = '✻'; await h.bridge.tick();
  h.advance(10000); pane.terminal_title_stripped = '⠋'; await h.bridge.tick();
  h.advance(60000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 0);
  assert.equal(h.store.forPane('w1:p1').topicRoot.publishedTitle, 'Session A');
});

test('uncertain title patch is rate limited across restart without losing the previous published name', async t => {
  const { h, pane } = await opened(t), patch = h.feishu.patch.bind(h.feishu);
  let attempts = 0;
  h.feishu.patch = async (id, card) => {
    if (id === h.bridge.store.forPane('w1:p1').topicId) { attempts++; throw Object.assign(new Error(), { code: 'network_error' }); }
    return patch(id, card);
  };
  pane.terminal_title_stripped = 'B'; await h.bridge.tick(); h.advance(10000); await h.bridge.tick();
  assert.equal(attempts, 1); assert.equal(h.store.forPane('w1:p1').topicRoot.publishedTitle, 'Session A');
  await h.restart(); await h.bridge.tick(); h.advance(10000); await h.bridge.tick(); assert.equal(attempts, 1);
  h.advance(50000); await h.bridge.tick(); assert.equal(attempts, 2);
});


test('ambiguous first input stays claimed and requires inspection after restart, without a second write or Enter', async t => {
  const h = await harness(t), event = message('danger');
  h.fake.drop('pane.send_text');
  await h.bridge.handle(event);
  assert.deepEqual(inputs(h).map(c => c.method), ['pane.send_text']);
  assert.equal(h.store.forPane('w1:p1').needs_check, true);
  await h.restart(); await h.bridge.handle({ ...event, eventId: 'redelivered' });
  assert.equal(inputs(h).length, 1);
  await h.bridge.handle(message('old thread', 'later', 'm1')); assert.equal(inputs(h).length, 1);
});

test('old user-thread pointers follow moves and show the latest published session title', async t => {
  const h = await harness(t); await h.bridge.handle(message('claude'));
  const old = h.store.forPane('w1:p1'), pane = h.fake.panes.get('w1:p1');
  await h.store.transaction(data => { (data.topicPointers ??= []).push({ chatId: 'oc_test', oldTopicId: 'old-request', topicId: old.topicId }); });
  pane.terminal_title_stripped = 'Renamed session';
  await h.bridge.handle(message('/t move', 'move', old.topicId));
  const current = h.store.forPane('w1:p1');
  assert.equal(h.store.data.topicPointers[0].topicId, current.topicId);
  await h.bridge.handle(message('do not input', 'later', 'old-request'));
  assert.equal(h.feishu.calls.at(-1).content, '已在新话题「Renamed session」打开，请到那里继续');
  assert.equal(inputs(h).length, 2);
});
