// W16-S9: `metame open` lists every project topic and attaches to the picked
// one. These tests drive the real Bridge against the hc backend fixture: the
// list order and fields, a dormant topic staying visible, an open that must not
// type anything, and the wake that resumes the SAME session without a card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { createBridge } from '../src/lib.js';
import { mockFeishu, message } from './helpers.js';

async function harness(t) {
  const home = await mkdtemp(new URL('../.test-w16s9-', import.meta.url)), cwd = 'C:\\fixture\\project';
  let time = Date.now(), sequence = 0;
  const now = () => time, terminals = new Map(), calls = [], errors = [];
  const h = { home, cwd, calls, terminals, errors, onRun: () => {}, onSleep: () => {} };
  const create = (props = {}) => {
    const address = `t${++sequence}`, pid = 1000 + sequence;
    const terminal = { address, pid, created_ms: time + sequence, state: 'live', cwd, labels: {},
      foreground: { pid, name: 'cmd.exe', argv: ['cmd.exe', '/c', 'pi.CMD'], cwd },
      reported: true, status: { app: 'pi', state: 'done' }, output: '$ ready', ...props };
    terminals.set(address, terminal); return terminal;
  };
  const client = {
    async request(method, params, hello) {
      calls.push({ method, params }); hello?.({ core: { id: 'fixture-core' } });
      const terminal = terminals.get(params.terminal);
      if (method === 'terminal.list') return { terminals: [...terminals.values()] };
      if (method === 'terminal.run') {
        const term = create({ labels: params.labels, cwd: params.cwd, argv: ['cmd.exe', '/c', params.line], status: null, reported: false });
        await h.onRun(term);
        return term;
      }
      if (!terminal) throw Object.assign(new Error('absent'), { code: 'not_found' });
      if (method === 'terminal.get') return terminal;
      if (method === 'terminal.read') return { text: terminal.output };
      if (method === 'terminal.send' || method === 'terminal.keys') return { turn: 0 };
      if (method === 'terminal.kill') { terminal.state = 'finished'; return terminal; }
      throw new Error(method);
    },
    subscribe() { return () => {}; }, close() {}, async raw() {},
  };
  // A known pi session so the wake path has a real id to resume.
  const dir = join(home, '.pi', 'agent', 'sessions', 'fixture');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'fixture_same.jsonl'), JSON.stringify({ type: 'session', id: 'same', cwd }) + '\n');
  const store = await new Store(join(home, 'state.json')).load(), feishu = mockFeishu(now);
  const backend = new Backends([new HcBackend(client)]);
  const follow = new SessionFollow({ home, procRoot: join(home, 'absent-proc'), now, sleep: async ms => { time += ms; } });
  const config = { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: cwd,
    groups: { oc_test: { project: 'w16', cwd, cli: 'pi' } } };
  const bridge = new Bridge({ backend, feishu, store, config, now, adapters: {}, sessionFollow: follow,
    audit: async () => {}, onError: error => errors.push(error),
    wakeOptions: { timeoutMs: 1000, sleep: async ms => { time += ms; await h.onSleep(); } } });
  const binding = topicId => store.binding('oc_test', topicId);
  Object.assign(h, { store, feishu, backend, follow, bridge, binding, create, config,
    advance(ms = 2000) { time += ms; },
    sends: () => calls.filter(c => c.method === 'terminal.send'),
    runs: () => calls.filter(c => c.method === 'terminal.run'),
    // `/t open` on an existing pane posts the topic root, so the bot's root
    // message id is the topic id the desktop picker will show.
    async openPane(paneId) {
      await bridge.handle(message(`/t open ${paneId}`, `event-${paneId}`));
      const created = store.forPane(paneId);
      assert.ok(created, `topic for ${paneId}`);
      return created.topicId;
    },
    // A reaped pane: the terminal is gone but the session id and CLI are kept.
    async dormant(topicId) {
      const paneId = binding(topicId).paneId;
      for (const terminal of terminals.values()) if (`hc:${terminal.address}` === paneId) terminal.state = 'finished';
      h.advance();
      await bridge.tick();
      assert.equal(binding(topicId).dormant, true);
    },
  });
  t.after(async () => { await bridge.stop(); await rm(home, { recursive: true, force: true }); });
  return h;
}

test('topics lists every project topic newest first with the fields the picker prints', async t => {
  const h = await harness(t);
  h.create({ created_ms: 0 }); h.create(); h.create();
  const [first, second, third] = [await h.openPane('hc:t1'), await h.openPane('hc:t2'), await h.openPane('hc:t3')];
  await h.store.update('oc_test', first, { lastInputAt: 1000 });
  // A member topic whose root text is empty takes the hc title instead.
  h.terminals.get('t2').title = '重构唤醒路径';
  await h.store.update('oc_test', second, { lastInputAt: 3000, member: '甲', memberName: '甲',
    topicRoot: { type: 'user', text: '', createdAt: 900 } });
  await h.store.update('oc_test', third, { lastInputAt: 2000,
    topicRoot: { type: 'user', text: 'x'.repeat(60), createdAt: 900 } });
  // A topic of a group this host no longer serves is not a project topic.
  await h.store.bind({ chatId: 'oc_other', topicId: 'foreign', paneId: 'hc:t9', identity: { terminalId: 'gone' } });

  const topics = await h.bridge.topics();
  assert.deepEqual(topics.map(topic => topic.topicId), [second, third, first]);
  assert.deepEqual(Object.keys(topics[0]).sort(),
    ['chatId', 'cli', 'group', 'lastInputAt', 'member', 'paneId', 'state', 'title', 'topicId']);
  assert.deepEqual(topics[0], { topicId: second, chatId: 'oc_test', group: 'w16', member: '甲', cli: 'pi',
    title: '重构唤醒路径', state: 'live', paneId: 'hc:t2', lastInputAt: 3000 });
  assert.equal(topics[1].title, 'x'.repeat(40));
  assert.equal(topics[1].member, null);
  assert.equal(topics[2].paneId, 'hc:t1');
  assert.ok(topics[2].title.length > 0 && topics[2].title.length <= 40);
});

test('a dormant topic stays listed as dormant', async t => {
  const h = await harness(t);
  h.create({ created_ms: 0 });
  const topicId = await h.openPane('hc:t1');
  await h.dormant(topicId);
  const topics = await h.bridge.topics();
  assert.equal(topics.length, 1);
  assert.equal(topics[0].topicId, topicId);
  assert.equal(topics[0].state, 'dormant');
  assert.equal(topics[0].paneId, 'hc:t1');
  assert.equal(typeof topics[0].lastInputAt, 'number');
});

test('open on a live topic returns its pane and posts or types nothing', async t => {
  const h = await harness(t);
  h.create({ created_ms: 0 });
  const topicId = await h.openPane('hc:t1');
  const posted = h.feishu.calls.length, runs = h.runs().length, sends = h.sends().length;
  assert.deepEqual(await h.bridge.openTopic(topicId), { paneId: 'hc:t1' });
  assert.equal(h.runs().length, runs);
  assert.equal(h.sends().length, sends);
  assert.equal(h.feishu.calls.length, posted);
});

test('open on a dormant topic wakes the same session with no card and no input', async t => {
  const h = await harness(t);
  h.create({ created_ms: 0 });
  const topicId = await h.openPane('hc:t1');
  const before = h.binding(topicId);
  await h.dormant(topicId);
  const mark = h.feishu.calls.length;
  // The launched CLI reports ready on the first poll, like a real resume.
  h.onRun = terminal => { terminal.reported = true; terminal.status = { app: 'pi', state: 'done' }; };
  const opened = await h.bridge.openTopic(topicId);
  const after = h.binding(topicId);
  assert.deepEqual(opened, { paneId: 'hc:t2' });
  assert.equal(after.dormant, false);
  assert.equal(after.sessionId, before.sessionId, 'the wake resumes the topic’s own session');
  assert.equal(h.runs().length, 1);
  assert.match(h.runs()[0].params.line, /^pi --session same$/);
  assert.equal(h.sends().length, 0, 'a desktop pick types nothing into the pane');
  assert.equal((after.queuedInputs ?? []).length, 0);
  const posted = h.feishu.calls.slice(mark);
  assert.deepEqual(posted.filter(call => call.msgType === 'interactive'), [], 'no wake card is posted');
  assert.deepEqual(posted.map(call => call.content), ['正在唤醒…']);
});

test('open rejects an unknown, empty or frozen topic without touching a terminal', async t => {
  const h = await harness(t);
  h.create({ created_ms: 0 });
  const topicId = await h.openPane('hc:t1');
  await assert.rejects(h.bridge.openTopic('missing'), { code: 'topic_not_found' });
  await assert.rejects(h.bridge.openTopic('   '), { code: 'topic_required' });
  await assert.rejects(h.bridge.openTopic(undefined), { code: 'topic_required' });
  await h.store.update('oc_test', topicId, { frozen: true });
  await assert.rejects(h.bridge.openTopic(topicId), { code: 'topic_frozen' });
  assert.equal((await h.bridge.topics())[0].state, 'dormant');
  assert.equal(h.runs().length, 0);
  assert.equal(h.sends().length, 0);
});

test('the library export wraps topics and open for the daemon', async t => {
  const transport = { send: async () => 'bot-1', reply: async () => 'bot-1', patch: async () => {}, getMessage: async () => ({}) };
  const bridge = createBridge({ config: {}, transport, registry: { get: () => null, list: () => [] },
    backends: {}, storeFile: 'unused-state.json', auditFile: 'unused-audit.jsonl' });
  assert.equal(typeof bridge.topics, 'function');
  assert.equal(typeof bridge.open, 'function');
  await assert.rejects(bridge.topics(), /not started/);
  await assert.rejects(bridge.open('open'), /not started/);
});