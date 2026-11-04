import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend, HcClient } from '../src/backends/hc.js';
import { coreHarness } from './ft25-helper.js';
import { message, pickerEvent } from './helpers.js';
import { topicTitle } from '../src/topics.js';
import { paneDetails } from '../src/panes.js';
import { screenCard } from '../src/render.js';

const id = 'fixture-session-1234567890';
const header = card => (card.body?.elements ?? card.elements)[0].content;
const payload = call => call.card ?? call.content ?? call.text;
const rootPatches = h => h.feishu.calls.filter(c => c.type === 'patch' && c.id === h.store.list()[0].topicId);
const mutations = h => h.hc.calls.filter(c => ['terminal.run', 'terminal.send', 'terminal.keys', 'terminal.kill', 'terminal.rm'].includes(c.method));

test('missing screen data never renders undefined or null, while literal terminal text is preserved', () => {
  for (const text of [undefined, null]) {
    const card = screenCard({ text, suppressMenu: true });
    assert.equal(card.elements[0].content, '```text\n\n```');
  }
  assert.equal(screenCard({ text: 'undefined', suppressMenu: true }).elements[0].content, '```text\nundefined\n```');
});

async function setup(t, cli = 'pi', props = {}) {
  const h = await coreHarness(t, { sessionFollow: 'warn' });
  h.bridge.adapters = {};
  const terminal = h.hc.create({ title: 'Design session', name: 'terminal-name', cwd: h.config.defaultCwd,
    labels: { session: id }, reported: true, status: { app: cli, state: 'idle' },
    foreground: { pid: 1200, name: cli, argv: [cli], cwd: h.config.defaultCwd }, ...props });
  await h.bridge.handle(message(`/t open hc:${terminal.address}`, 'open'));
  return { ...h, terminal, binding: () => h.store.forPane(`hc:${terminal.address}`) };
}

test('topic and picker names prefer CLI title, terminal name, agent, then foreground over location', () => {
  const pane = { title: 'CLI session', terminal_title_stripped: 'CLI session', name: 'terminal-name', agent: 'sh',
    foreground: { name: 'ssh' }, cwd: '/home/ubuntu/1', where: 'ubuntu / 1' };
  for (const [props, expected] of [
    [{}, 'CLI session'],
    [{ title: '', terminal_title_stripped: '' }, 'terminal-name'],
    [{ title: '', terminal_title_stripped: '', name: '' }, 'sh'],
    [{ title: '', terminal_title_stripped: '', name: '', agent: null }, 'ssh'],
  ]) {
    const terminal = { ...pane, ...props };
    assert.equal(topicTitle(terminal), expected);
    assert.equal(paneDetails(terminal).title, expected);
  }
});

test('an untitled ssh screen terminal shows its hc name in ls, picker and topic with unknown status', async t => {
  const h = await coreHarness(t, { sessionFollow: 'warn' });
  h.bridge.adapters = {};
  const terminal = h.hc.create({ name: 'NAME', title: '', agent: 'sh', reported: false, status: null,
    where: 'ubuntu / 1', cwd: '/home/ubuntu/1', argv: ['ssh', '-t', 'mac', 'screen', '-x', 'NAME'],
    foreground: { pid: 1200, name: 'sh', argv: ['ssh', '-t', 'mac', 'screen', '-x', 'NAME'], cwd: '/home/ubuntu/1' },
    output: '❯ ' });
  const before = mutations(h).length;
  await h.bridge.handle(message('/t ls', 'ssh-list'));
  const picker = h.store.data.actionCards.at(-1), entry = picker.entries.find(e => e.paneId === `hc:${terminal.address}`);
  assert.equal(entry.title, 'NAME');
  assert.match(entry.summary, /sh · 状态未知/);
  assert.ok(entry.label.includes('NAME ·'));
  const list = h.feishu.calls.at(-1).content;
  assert.equal(list.elements[1].text.content.split('\n')[0], '**NAME**');
  assert.equal(mutations(h).length, before);
  await h.bridge.handle(pickerEvent({ bridge: h.bridge }, 'open'));
  const binding = h.store.forPane(`hc:${terminal.address}`);
  assert.ok(binding);
  const root = h.feishu.calls.find(c => c.type === 'send').text;
  assert.equal(root.header.title.content, 'NAME');
  assert.match(header(root), /会话：NAME · 编号未知/);
  assert.equal(h.bridge.state(binding).status, 'unknown');
  assert.equal(mutations(h).length, before);
  terminal.name = 'RENAMED'; h.advance(); await h.bridge.tick(); h.advance(10000); await h.bridge.tick();
  assert.equal(h.store.forPane(binding.paneId).topicRoot.publishedTitle, 'RENAMED');
});

for (const cli of ['claude', 'codex', 'pi']) {
  test(`${cli} root and status card show session title and short ID; info returns the full ID without input`, async t => {
    const h = await setup(t, cli), root = h.feishu.calls.find(c => c.type === 'send');
    assert.equal(root.text.header.title.content, 'Design session');
    assert.match(header(root.text), /会话：Design session · fixture-/);
    assert.ok(!JSON.stringify(root.text).includes(id));
    assert.equal(h.binding().sessionTitle, 'Design session');
    await h.bridge.tick();
    const status = h.feishu.calls.find(c => c.id === h.binding().cardId);
    assert.match(header(payload(status)), /会话：Design session · fixture-/);
    const before = mutations(h).length;
    await h.bridge.handle(message('/t info', 'info', h.binding().topicId));
    assert.equal(h.feishu.calls.at(-1).content, `会话：Design session\nCLI：${cli}\n会话 ID：\n${id}`);
    assert.equal(mutations(h).length, before);
  });
}

test('title changes debounce, coalesce and respect the durable root rate limit', async t => {
  const h = await setup(t);
  h.terminal.title = 'First'; await h.bridge.tick();
  h.advance(9000); h.terminal.title = 'Final'; await h.bridge.tick();
  h.advance(9000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 0);
  h.advance(1000); await h.bridge.tick();
  assert.equal(rootPatches(h).length, 1);
  assert.equal(rootPatches(h)[0].card.header.title.content, 'Final');
  assert.match(header(rootPatches(h)[0].card), /会话：Final · fixture-/);
  h.terminal.title = 'Next'; h.advance(1000); await h.bridge.tick();
  h.advance(10000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 1);
  h.advance(49000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 2);
  assert.equal(rootPatches(h)[1].card.header.title.content, 'Next');
  assert.deepEqual(h.errors, []);
});

test('late session ID updates an unchanged root title and active status header', async t => {
  const h = await setup(t, 'pi', { labels: {} });
  assert.match(header(h.feishu.calls.find(c => c.type === 'send').text), /编号未知/);
  await h.bridge.tick();
  h.terminal.labels.session = id;
  h.advance(1000); await h.bridge.tick();
  h.advance(9000); await h.bridge.tick(); assert.equal(rootPatches(h).length, 0);
  h.advance(1000); await h.bridge.tick();
  assert.equal(rootPatches(h).length, 1);
  assert.equal(rootPatches(h)[0].card.header.title.content, 'Design session');
  assert.match(header(rootPatches(h)[0].card), /fixture-/);
  const status = h.feishu.calls.findLast(c => c.id === h.binding().cardId);
  assert.match(header(payload(status)), /fixture-/);
});

test('dormant info survives restart without waking, even when the terminal is gone', async t => {
  const h = await setup(t);
  h.terminal.state = 'finished'; h.advance(); await h.bridge.tick();
  assert.equal(h.binding().dormant, true);
  h.hc.terminals.delete(h.terminal.address);
  await h.bridge.stop();
  const store = await new Store(h.store.file).load();
  const backend = new Backends([new HcBackend(new HcClient({ endpoint: h.hc.endpoint }))]);
  const restored = new Bridge({ backend, feishu: h.feishu, store, config: h.config,
    now: h.now, sessionFollow: h.follow, adapters: {}, audit: async () => {} });
  t.after(() => restored.stop());
  const before = mutations(h).length;
  await restored.handle(message('/t info', 'restored-info', h.binding().topicId));
  assert.equal(h.feishu.calls.at(-1).content, `会话：Design session\nCLI：pi\n会话 ID：\n${id}`);
  assert.equal(mutations(h).length, before);
});

test('existing roots acquire the ID header after restart without creating another topic', async t => {
  const h = await setup(t);
  await h.bridge.stop();
  const saved = h.binding(), { publishedSessionId, ...oldRoot } = saved.topicRoot;
  await h.store.update(saved.chatId, saved.topicId, { sessionTitle: null, topicRoot: oldRoot });
  const store = await new Store(h.store.file).load();
  const backend = new Backends([new HcBackend(new HcClient({ endpoint: h.hc.endpoint }))]);
  const restored = new Bridge({ backend, feishu: h.feishu, store, config: h.config,
    now: h.now, sessionFollow: h.follow, adapters: {}, audit: async () => {} });
  t.after(() => restored.stop());
  await restored.start({ timers: false });
  await restored.tick(); h.advance(10000); await restored.tick();
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 1);
  assert.equal(rootPatches(h).length, 1);
  assert.match(header(rootPatches(h)[0].card), /会话：Design session · fixture-/);
  const persisted = await new Store(h.store.file).load();
  assert.equal(persisted.list()[0].topicRoot.publishedSessionId, id);
  assert.equal(persisted.list()[0].sessionTitle, 'Design session');
  h.advance(60000); await restored.tick(); assert.equal(rootPatches(h).length, 1);
});

test('unknown and unbound info never guess an ID or submit a command; ACL still applies', async t => {
  const h = await setup(t, 'pi', { labels: {} });
  const before = mutations(h).length;
  await h.bridge.handle(message('/t info', 'unknown', h.binding().topicId));
  assert.match(h.feishu.calls.at(-1).content, /未知，暂未取得可靠的会话编号/);
  await h.bridge.handle(message('/t info', 'unbound'));
  assert.match(h.feishu.calls.at(-1).content, /请先发送 \/t ls/);
  await h.bridge.handle(message('/t info', 'denied', h.binding().topicId, { openId: 'ou_denied' }));
  assert.match(h.feishu.calls.at(-1).content, /还没有控制权限/);
  assert.ok(!h.feishu.calls.at(-1).content.includes(id));
  assert.equal(mutations(h).length, before);
});

test('a manually opened child shows its own session identity and escaped title', async t => {
  const h = await setup(t);
  const childId = 'child-fixture-1234567890';
  const child = h.hc.create({ parent: h.terminal.address, title: '<at id=all> **child**',
    labels: { session: childId }, cwd: h.config.defaultCwd,
    foreground: { pid: 1201, name: 'pi', argv: ['pi'], cwd: h.config.defaultCwd } });
  await h.bridge.handle(message(`/t open hc:${child.address}`, 'open-child'));
  const root = h.feishu.calls.findLast(c => c.type === 'send').text;
  assert.equal(root.header.title.content, '└ <at id=all> **child** · Design session');
  assert.match(header(root), /&lt;at id=all&gt; \\\*\\\*child\\\*\\\* · child-fi/);
  assert.ok(!header(root).includes('<at'));
  await h.bridge.handle(message('/t info', 'child-info', h.store.forPane(`hc:${child.address}`).topicId));
  assert.ok(h.feishu.calls.at(-1).content.endsWith('\n' + childId));
});

test('turn and menu cards keep session identity when titles and IDs change without new output', async t => {
  const h = await setup(t), records = [];
  h.bridge.adapters.pi = { locate: async () => 'fixture-turns', read: async (_path, cursor) => ({
    cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
  }) };
  await h.bridge.tick();
  records.push({ role: 'assistant', text: 'An answer' });
  h.advance(); await h.bridge.tick();
  const cardId = h.binding().cardId;
  assert.match(header(payload(h.feishu.calls.findLast(c => c.id === cardId))), /会话：Design session · fixture-/);
  h.terminal.title = 'Renamed'; h.terminal.labels.session = 'new-session-fixture';
  h.advance(); await h.bridge.tick();
  const updated = payload(h.feishu.calls.findLast(c => c.id === cardId));
  assert.match(header(updated), /会话：Renamed · new-sess/);
  assert.match(JSON.stringify(updated), /An answer/);
  h.terminal.output = 'Select model\n❯ First model\n  Second model\nEsc to cancel';
  h.advance(); await h.bridge.tick();
  assert.ok(h.binding().menuCardId);
  const menu = payload(h.feishu.calls.findLast(c => c.id === h.binding().menuCardId));
  assert.match(header(menu), /会话：Renamed · new-sess/);
});

test('an uncertain turn publication keeps its payload then catches up with a changed session header', async t => {
  const h = await setup(t), records = [];
  h.bridge.adapters.pi = { locate: async () => 'fixture-turns', read: async (_path, cursor) => ({
    cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
  }) };
  await h.bridge.tick();
  const reply = h.feishu.reply.bind(h.feishu);
  h.feishu.reply = async (_topic, card) => {
    if (card?.header?.title.content.startsWith('🤖 ')) throw Object.assign(new Error('lost'), { code: 'network_error' });
    return reply(_topic, card);
  };
  records.push({ role: 'assistant', text: 'An answer' });
  h.advance(); await h.bridge.tick();
  const pending = h.binding().pendingCard;
  assert.ok(pending);
  h.terminal.title = 'Renamed during retry';
  h.feishu.reply = async (topic, card, type, uuid) => {
    if (uuid === pending.uuid) assert.deepEqual(card, pending.card);
    return reply(topic, card, type, uuid);
  };
  h.advance(4000); await h.bridge.tick();
  assert.equal(h.binding().pendingCard, null);
  h.advance(2000); await h.bridge.tick();
  const card = payload(h.feishu.calls.findLast(c => c.id === h.binding().cardId));
  assert.match(header(card), /会话：Renamed during retry · fixture-/);
  assert.match(JSON.stringify(card), /An answer/);
});
