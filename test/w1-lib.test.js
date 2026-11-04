import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createBridge, createConfigRegistry } from 'feishu-terminal';
import { normalizeEvent, markCard } from '../src/events.js';
import { Backends } from '../src/backends/index.js';
import { HerdrBackend } from '../src/backends/herdr.js';
import { HerdrClient } from '../src/herdr-client.js';
import { Store } from '../src/store.js';
import { Feishu } from '../src/feishu.js';
import { menuCard, screenCard, pickerCard } from '../src/render.js';
import { renderSchema } from '../src/card-schema.js';
import { loadConfig } from '../src/config.js';
import { fakeHerdr } from './helpers.js';
import { FakeTransport } from './fake-transport.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/w1-events.json', import.meta.url), 'utf8'));
function message(text, chatId = 'oc_test1', openId = 'ou_test', id = 'om_input1', root) {
  const raw = structuredClone(fixtures.message);
  raw.header.event_id = `ev_${id}`;
  raw.event.sender.sender_id.open_id = openId;
  Object.assign(raw.event.message, { content: JSON.stringify({ text }), chat_id: chatId, message_id: id,
    ...(root ? { root_id: root } : {}) });
  return raw;
}
function callbacks(card) {
  const values = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.value?.key) values.push(node.value);
    Object.values(node).forEach(visit);
  };
  visit(card); return values;
}
async function fixture(t, oldState) {
  const root = await mkdtemp(new URL('../.test-w1-', import.meta.url));
  const fake = await fakeHerdr();
  const transport = new FakeTransport(), logs = [];
  const storeFile = join(root, 'state.json'), auditFile = join(root, 'audit.jsonl');
  if (oldState) await writeFile(storeFile, JSON.stringify(oldState));
  const config = { chatIds: ['oc_test1', 'oc_test2'], defaultCwd: root, operatorOpenIds: ['ou_test'], sessionFollow: 'warn',
    groups: { oc_test1: { project: 'one', cwd: join(root, 'one'), machine: 'test' },
      oc_test2: { project: 'two', cwd: join(root, 'two'), operatorOpenIds: ['ou_second'] } } };
  const registry = createConfigRegistry(config);
  const backends = new Backends([new HerdrBackend(new HerdrClient({ endpoint: fake.endpoint, timeoutMs: 500 }))], { newTerminalBackend: 'herdr' });
  const bridge = createBridge({ config, registry, transport, backends, storeFile, auditFile, log: code => logs.push(code), clock: () => 1234 });
  t.after(async () => { await bridge.stop(); await fake.close(); await rm(root, { recursive: true, force: true }); });
  await bridge.start({ timers: false });
  return { bridge, config, registry, transport, fake, logs, storeFile, auditFile,
    state: () => new Store(storeFile).load() };
}

test('public bridge isolates two groups, topics, group cwd, picker actions and operator ACL', async t => {
  const h = await fixture(t);
  assert.equal(await h.bridge.handle(message('pwd')), true);
  assert.equal(await h.bridge.handle(message('date', 'oc_test2', 'ou_second', 'om_input2')), true);
  let state = await h.state();
  const [one, two] = state.list();
  assert.equal(one.chatId, 'oc_test1'); assert.equal(two.chatId, 'oc_test2');
  assert.notEqual(one.topicId, two.topicId); assert.notEqual(one.paneId, two.paneId);
  assert.deepEqual(h.fake.calls.filter(c => ['workspace.create', 'tab.create'].includes(c.method)).map(c => c.params.cwd),
    [h.config.groups.oc_test1.cwd, h.config.groups.oc_test2.cwd]);
  const writeCount = () => h.fake.calls.filter(c => c.method === 'pane.send_text').length;
  const count = writeCount();
  await h.bridge.handle(message('denied', 'oc_test2', 'ou_test', 'om_denied', two.topicId));
  assert.equal(writeCount(), count);
  assert.match(h.transport.calls.at(-1).content, /控制权限/);
  await h.bridge.handle(message('echo two', 'oc_test2', 'ou_second', 'om_two', two.topicId));
  assert.equal(h.fake.calls.filter(c => c.method === 'pane.send_text').at(-1).params.pane_id, two.paneId);
  // Cross-chat topic IDs never resolve a binding or write into its terminal.
  await h.bridge.handle(message('cross', 'oc_test1', 'ou_test', 'om_cross', two.topicId));
  assert.equal(writeCount(), count + 1);
  await h.bridge.handle(message('/t ls', 'oc_test1', 'ou_test', 'om_list1'));
  await h.bridge.handle(message('/t ls', 'oc_test2', 'ou_second', 'om_list2'));
  state = await h.state();
  const [first, second] = state.data.actionCards;
  assert.equal(first.chatId, 'oc_test1'); assert.equal(second.chatId, 'oc_test2');
  const reply = h.transport.calls.find(c => c.id === first.messageId);
  const value = callbacks(reply.content).find(v => v.key.startsWith('picker:close:'));
  assert.equal(value.ft_bridge, 'feishu-terminal');
  const action = structuredClone(fixtures.action);
  action.event.context = { open_chat_id: second.chatId, open_message_id: first.messageId };
  action.event.operator.open_id = 'ou_second'; action.event.action.value = value;
  const before = writeCount(); await h.bridge.handle(action);
  assert.equal(writeCount(), before); assert.deepEqual((await h.state()).list(), state.list());
  assert.equal((await readFile(h.auditFile, 'utf8')).includes('first_input'), true);
});

test('public handle rejects unknown chats, foreign cards and event types without any side effects', async t => {
  const h = await fixture(t);
  const foreign = structuredClone(fixtures.action); delete foreign.event.action.value.ft_bridge;
  for (const raw of [message('ignore', 'oc_unknown'), foreign, fixtures.action, { header: { event_type: 'im.chat.updated_v1' }, event: {} }, null])
    assert.equal(await h.bridge.handle(raw), false);
  assert.equal(h.transport.calls.length, 0); assert.equal(h.fake.calls.length, 0); assert.deepEqual(h.logs, []);
  await assert.rejects(readFile(h.storeFile), { code: 'ENOENT' });
  await assert.rejects(readFile(h.auditFile), { code: 'ENOENT' });
});

test('JSON fixtures normalize identically through WS envelopes and flattened SDK deliveries', async t => {
  for (const raw of Object.values(fixtures)) {
    const sdk = { ...raw.event, event_id: raw.header.event_id, event_type: raw.header.event_type };
    assert.deepEqual(normalizeEvent(raw), normalizeEvent(sdk));
  }
  const h = await fixture(t);
  const raw = fixtures.message;
  assert.equal(await h.bridge.handle(raw), true);
  const count = h.fake.calls.length;
  assert.equal(await h.bridge.handle({ ...raw.event, event_id: raw.header.event_id, event_type: raw.header.event_type }), true);
  assert.equal(h.fake.calls.length, count, 'same delivery is durably deduplicated');
});

test('own card marker survives picker, status, menu, v1/v2 conversion and replay without mutating saved payloads', () => {
  const samples = [pickerCard({ kind: 'list', topicId: 'om_topic1', nonce: 'n', entries: [{ label: 'test', paneId: 'p' }] }),
    screenCard({ topicId: 'om_topic1', nonce: 'n', text: 'Continue? [y/n]', status: 'blocked', label: 'test' }),
    menuCard({ menu: { kind: 'numbered', items: [{ label: 'yes' }], cursorIndex: 0 }, topicId: 'om_topic1', nonce: 'n' })];
  for (const card of samples) for (const version of ['1.0', '2.0']) {
    const original = structuredClone(card);
    const rendered = markCard(renderSchema(card, version));
    assert.ok(callbacks(rendered).length);
    assert.ok(callbacks(rendered).every(v => v.ft_bridge === 'feishu-terminal'));
    assert.deepEqual(card, original);
  }
});

test('old version-one state loads without migration or rewriting; legacy bindings remain readable', async t => {
  const old = { version: 1, bindings: [{ chatId: 'oc_test1', topicId: 'om_old', paneId: 'old-pane', frozen: true }], seen: ['event:old'] };
  const h = await fixture(t, old);
  assert.deepEqual((await h.state()).data, old);
  assert.equal(await readFile(h.storeFile, 'utf8'), JSON.stringify(old));
  assert.equal(await h.bridge.handle(message('/t ls')), true);
  assert.equal((await h.state()).binding('oc_test1', 'om_old').paneId, 'old-pane');
});

test('config registry supports legacy defaults, groups-only additions and an explicit empty group ACL', () => {
  const config = { chatIds: ['oc_test1'], defaultCwd: '/test', operatorOpenIds: ['ou_test'],
    groups: { oc_test2: { project: 'second', operatorOpenIds: [] } } };
  const registry = createConfigRegistry(config);
  assert.equal(registry.list().length, 2); assert.equal(registry.get('oc_unknown'), null);
  assert.deepEqual(registry.get('oc_test1').operatorOpenIds, ['ou_test']);
  assert.deepEqual(registry.get('oc_test2').operatorOpenIds, []);
  registry.get('oc_test1').operatorOpenIds.push('ou_bad');
  assert.deepEqual(registry.get('oc_test1').operatorOpenIds, ['ou_test']);
});

test('standalone wiring builds the built-in transport and supplies raw deliveries to the shared library', async () => {
  const cli = await readFile(new URL('../bin/feishu-terminal.js', import.meta.url), 'utf8');
  assert.match(cli, /new Feishu\(/); assert.match(cli, /new FeishuWSClient\(/);
  assert.match(cli, /createBridge\(/); assert.match(cli, /createConfigRegistry\(config\)/);
  assert.match(cli, /transport\.start\(raw => bridge\.accept\(raw\)/);
  let dispatcher;
  const edge = new Feishu({ client: {}, ws: { start({ eventDispatcher }) { dispatcher = eventDispatcher; }, close() {} } });
  const received = [];
  await edge.start(raw => received.push(raw), undefined, { rawEvents: true });
  await dispatcher.invoke(fixtures.message); await dispatcher.invoke(fixtures.action);
  assert.deepEqual(received, [fixtures.message, fixtures.action]); edge.close();
});

test('config file accepts multiple groups and validates per-group ACL and cwd', async t => {
  const dir = await mkdtemp(new URL('../.test-w1-config-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const base = { chatIds: ['oc_test1', 'oc_test2'], operatorOpenIds: ['ou_test'], defaultCwd: dir,
    groups: { oc_test2: { cwd: dir, project: 'two', operatorOpenIds: ['ou_second'] } } };
  const env = { FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture', FEISHU_TERMINAL_CONFIG: file };
  await writeFile(file, JSON.stringify(base));
  const loaded = await loadConfig(env);
  assert.equal(createConfigRegistry(loaded).list().length, 2);
  for (const groups of [[], { oc_test2: { operatorOpenIds: ['invalid'] } }, { oc_test2: { cwd: 'relative' } }]) {
    await writeFile(file, JSON.stringify({ ...base, groups }));
    await assert.rejects(loadConfig(env));
  }
});
