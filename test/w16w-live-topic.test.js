import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { mockFeishu, message } from './helpers.js';

// W16-W: a new topic must start beside live topics of the same CLI sharing the
// group cwd. The wake guard only protects a non-fresh wake from duplicating a
// session that runs outside ft, never a freshLaunch or a pane ft already owns.
async function harness(t) {
  const home = await mkdtemp(new URL('../.test-w16w-', import.meta.url));
  const cwd = 'C:\\fixture\\project';
  let time = Date.now(), sequence = 0;
  const now = () => time, terminals = new Map(), calls = [], errors = [];
  const h = { home, cwd, calls, terminals, errors, onRun: () => {}, advance: ms => { time += ms; } };
  const create = (props = {}) => {
    const address = `t${++sequence}`, pid = 1000 + sequence;
    const terminal = { address, pid, created_ms: time + sequence, state: 'live', cwd: props.cwd ?? cwd, labels: {},
      foreground: { pid, name: 'cmd.exe', argv: ['cmd.exe', '/c', props.line ?? 'powershell.exe'], cwd: props.cwd ?? cwd },
      reported: false, status: null, output: '', ...props };
    terminals.set(address, terminal); return terminal;
  };
  const client = {
    async request(method, params, hello) {
      calls.push({ method, params }); hello?.({ core: { id: 'fixture-core' } });
      const terminal = terminals.get(params.terminal);
      if (method === 'terminal.list') return { terminals: [...terminals.values()] };
      if (method === 'terminal.run') {
        const term = create({ labels: params.labels, cwd: params.cwd, line: params.line, parent: params.parent });
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
  const store = await new Store(join(home, 'state.json')).load(), feishu = mockFeishu(now);
  const backend = new Backends([new HcBackend(client)]);
  const follow = new SessionFollow({ home, procRoot: join(home, 'absent-proc'), now, sleep: async ms => { time += ms; } });
  const config = { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: cwd,
    groups: { oc_test: { cwd, cli: 'codex' } } };
  const bridge = new Bridge({ backend, feishu, store, config, now, adapters: {}, sessionFollow: follow,
    audit: async () => {}, onError: error => errors.push(error),
    wakeOptions: { timeoutMs: 20000, sleep: async ms => { time += ms; } } });
  Object.assign(h, { store, feishu, backend, bridge, create,
    runs: () => calls.filter(c => c.method === 'terminal.run'),
    ready(term, state = 'idle', app = 'codex') { term.reported = true; term.status = { app, state }; },
  });
  t.after(async () => { await bridge.stop(); await rm(home, { recursive: true, force: true }); });
  return h;
}

// A dormant binding whose pane is gone and whose session id is unknown to the
// portable follow: its wake falls through to the fresh-launch guard.
async function bindDormant(h, topicId, paneId = 'hc:gone', sessionId = 'ghost123') {
  await h.store.bind({ chatId: 'oc_test', topicId, paneId,
    identity: { terminalId: `ghost-${topicId}`, pid: 1, created_ms: 0 },
    cli: 'codex', cwd: h.cwd, sessionId, dormant: true, frozen: false });
}

test('two fresh topics with the same CLI and cwd both create a pane', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('只回复 A1', 'root-a'));
  await h.bridge.handle(message('只回复 B2', 'root-b'));
  const runs = h.runs();
  assert.equal(runs.length, 2, 'the live unverified pane of the first topic must not block the second fresh topic');
  assert.equal(runs[0].params.line, 'codex --no-daemon -c check_for_update_on_startup=false');
  assert.equal(runs[1].params.line, 'codex --no-daemon -c check_for_update_on_startup=false');
  const [a, b] = h.store.list();
  assert.equal(a.paneId, 'hc:t1');
  assert.equal(b.paneId, 'hc:t2');
  assert.equal(b.dormant, false);
  assert.deepEqual(h.errors, []);
});

test('repeated verification observes each binding at most once per poll interval', async t => {
  const h = await harness(t);
  const terminal = h.create();
  const pane = await h.backend.get(`hc:${terminal.address}`);
  await h.store.bind({ chatId: 'oc_test', topicId: 'poll', paneId: pane.pane_id, identity: h.backend.identity(pane) });
  const binding = h.store.binding('oc_test', 'poll');
  let observations = 0;
  h.bridge.wake.observe = async () => { observations++; };
  await Promise.all([h.bridge.verify(binding), h.bridge.verify(binding)]);
  await h.bridge.verify(binding);
  assert.equal(observations, 1);
  h.advance(250);
  await h.bridge.verify(binding);
  assert.equal(observations, 2);
  h.bridge.tickPending = true; h.bridge.observeTick = 1;
  h.advance(250); await h.bridge.verify(binding);
  h.advance(1000); await h.bridge.verify(binding);
  assert.equal(observations, 3, 'a slow tick still observes only once');
  h.bridge.tickPending = false;
});

test('a live pane owned by another topic does not block a non-fresh wake', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  // Topic A starts normally, owning live unverified codex pane hc:t1.
  await h.bridge.handle(message('只回复 A1', 'root-a'));
  assert.equal(h.runs().length, 1);
  // Topic B is dormant with an unfollowable session id; A's owned pane must not block it.
  await bindDormant(h, 'root-b');
  await h.bridge.handle(message('wake text', 'wake-1', 'root-b'));
  const runs = h.runs();
  assert.equal(runs.length, 2, 'an owned unverified pane is already known to ft and cannot be the outside-ft session');
  assert.match(runs[1].params.line, /^codex resume ghost123\b/);
  const binding = h.store.binding('oc_test', 'root-b');
  assert.equal(binding.paneId, 'hc:t2');
  assert.equal(binding.dormant, false);
  assert.deepEqual(h.errors, []);
});

test('an unowned unverified pane still blocks a non-fresh wake', async t => {
  const h = await harness(t);
  // A codex pane in the same cwd that no binding owns: possibly the same
  // session running outside ft. Only a freshLaunch may start beside it.
  h.create({ reported: true, status: { app: 'codex', state: 'idle' } });
  await bindDormant(h, 'root-a');
  await h.bridge.handle(message('wake text', 'wake-1', 'root-a'));
  assert.equal(h.runs().length, 0, 'the guard must keep its original purpose');
  assert.equal(h.store.binding('oc_test', 'root-a').dormant, true);
  // The same topic as a freshLaunch still starts.
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('只回复 B2', 'root-b'));
  assert.equal(h.runs().length, 1);
  assert.equal(h.store.binding('oc_test', 'root-b').paneId, 'hc:t2');
  assert.deepEqual(h.errors, []);
});

// Two concurrent fresh codex topics in one cwd produce two session files that
// both panes probe. Each binding must claim only the session containing the
// exact text ft sent into its own pane, regardless of probe candidate order.
async function twoTopicSessions(t, textA = '只回复 A1', textB = '只回复 B2') {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message(textA, 'root-a'));
  await h.bridge.handle(message(textB, 'root-b'));
  const dir = join(h.home, '.codex', 'sessions', '2026', '11', '09');
  await mkdir(dir, { recursive: true });
  const meta = (id, text) => JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(),
    payload: { session_id: id, cwd: h.cwd } }) + String.fromCharCode(10) +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + String.fromCharCode(10);
  // Name B's file first so candidate order cannot decide the attribution.
  await writeFile(join(dir, 'rollout-000b-idb.jsonl'), meta('idb', textB));
  await writeFile(join(dir, 'rollout-000a-ida.jsonl'), meta('ida', textA));
  for (const [topic, pane] of [['root-a', 't1'], ['root-b', 't2']]) {
    h.advance(2000); // the session probe throttles to one pass per simulated second
    await h.bridge.wake.observe(h.store.binding('oc_test', topic), h.terminals.get(pane));
  }
  return h;
}

test('each concurrent fresh topic claims its own probed session', async t => {
  const h = await twoTopicSessions(t);
  assert.equal(h.store.binding('oc_test', 'root-a').sessionId, 'ida');
  assert.equal(h.store.binding('oc_test', 'root-a').sessionSource, 'probe');
  assert.equal(h.store.binding('oc_test', 'root-b').sessionId, 'idb');
  assert.equal(h.store.binding('oc_test', 'root-b').sessionSource, 'probe');
});

test('identical texts never let one topic claim the other pane session', async t => {
  const h = await twoTopicSessions(t, '相同的问题文本', '相同的问题文本');
  const [a, b] = ['root-a', 'root-b'].map(id => h.store.binding('oc_test', id).sessionId ?? null);
  assert.ok(a !== b, 'a session must never be attributed to both concurrent topics');
});

// /engine switches the binding's cli and goes dormant until the new CLI's
// fresh launch completes. An observe racing against the teardown of the old
// pane must not write the old CLI back.
test('a stale observation cannot overwrite an engine switch mid-wake', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('只回复 A1', 'root-a'));
  await h.store.update('oc_test', 'root-a', { cli: 'pi', sessionId: null, sessionSource: null, sessionVerified: false,
    cliCommand: 'pi', freshLaunch: true, dormant: true, wakePending: false, wakeAttempt: null });
  h.advance(2000);
  await h.bridge.wake.observe(h.store.binding('oc_test', 'root-a'), h.terminals.get('t1')); // re-fetched binding: same generation as the switch
  const binding = h.store.binding('oc_test', 'root-a');
  assert.equal(binding.cli, 'pi', 'facts from the dying codex pane must not undo the switch');
  assert.equal(binding.dormant, true);
});
