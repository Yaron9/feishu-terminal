import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { route } from '../src/router.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { mockFeishu, message } from './helpers.js';

test('/engine parses case-insensitively and never reaches the terminal', () => {
  assert.deepEqual(route('/engine'), { type: 'engine', name: null });
  assert.deepEqual(route('/engine', true), { type: 'engine', name: null });
  assert.deepEqual(route('/ENGINE Codex'), { type: 'engine', name: 'codex' });
  assert.deepEqual(route('/engine   pi\n'), { type: 'engine', name: 'pi' });
  assert.deepEqual(route('/engine zzz', true), { type: 'engine', name: 'zzz' });
  // /engine stays an ft command even while a terminal is bound, but plain
  // text and unrelated slash words keep their ordinary paths.
  assert.deepEqual(route('/engines x', true), { type: 'input', text: '/engines x' });
  assert.deepEqual(route('engine', true), { type: 'input', text: 'engine' });
  assert.deepEqual(route('/t raw /engine', true), { type: 'raw', text: '/engine' });
});

// Fake hc backend. terminal.run records the launch line, terminal.keys is
// observable through onKeys so a test can make the CLI exit on demand.
async function harness(t, { groupCli = 'codex', timeoutMs = 20000 } = {}) {
  const home = await mkdtemp(new URL('../.test-w16e-', import.meta.url));
  const cwd = 'C:\\fixture\\project';
  let time = Date.now(), sequence = 0;
  const now = () => time, terminals = new Map(), calls = [], audits = [], errors = [];
  const h = { home, cwd, calls, terminals, audits, errors, onRun: () => {}, onSleep: () => {}, onKeys: () => {} };
  const create = (props = {}) => {
    const address = `t${++sequence}`, pid = 1000 + sequence;
    const terminal = { address, pid, created_ms: time + sequence, state: 'live', cwd: props.cwd ?? cwd, labels: {},
      foreground: { pid, name: 'cmd.exe', argv: ['cmd.exe', '/c', props.line ?? 'powershell.exe'], cwd: props.cwd ?? cwd },
      reported: false, status: null, output: 'Update available. Press Enter to continue.', ...props };
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
      if (method === 'terminal.send') return { turn: 0 };
      if (method === 'terminal.keys') { await h.onKeys(terminal, params.keys); return { turn: 0 }; }
      if (method === 'terminal.kill') { terminal.state = 'finished'; return terminal; }
      throw new Error(method);
    },
    subscribe() { return () => {}; }, close() {}, async raw() {},
  };
  const store = await new Store(join(home, 'state.json')).load(), feishu = mockFeishu(now);
  const backend = new Backends([new HcBackend(client)]);
  const follow = new SessionFollow({ home, procRoot: join(home, 'absent-proc'), now, sleep: async ms => { time += ms; } });
  const config = { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: 'C:\\fixture\\default',
    groups: { oc_test: { cwd, ...(groupCli ? { cli: groupCli } : {}) } } };
  const bridge = new Bridge({ backend, feishu, store, config, now, adapters: {}, sessionFollow: follow,
    audit: async record => audits.push(record), onError: error => errors.push(error),
    wakeOptions: { timeoutMs, sleep: async ms => { time += ms; await h.onSleep(); } },
    reapOptions: { sleep: async ms => { time += ms; } } });
  const liveCodex = term => h.ready(term, 'idle', String(term.foreground?.argv ?? '').includes('claude') ? 'claude' : 'codex');
  Object.assign(h, { store, feishu, backend, bridge, config, create, liveCodex,
    advance(ms = 2000) { time += ms; },
    sends: () => calls.filter(c => c.method === 'terminal.send'),
    keys: () => calls.filter(c => c.method === 'terminal.keys'),
    runs: () => calls.filter(c => c.method === 'terminal.run'),
    ready(term, state = 'idle', app = 'codex') { term.reported = true; term.status = { app, state }; },
    binding: () => store.list()[0],
    cards: () => feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive'),
    engineButton: (key, override = {}) => {
      const card = store.data.actionCards.find(c => c.kind === 'engine');
      return { kind: 'button', eventId: `b-${Math.random()}`, chatId: card.chatId, openId: 'ou_test',
        topicId: card.topicId, messageId: card.messageId, nonce: card.nonce, key, ...override };
    },
  });
  t.after(async () => { await bridge.stop(); await rm(home, { recursive: true, force: true }); });
  return h;
}

// A live codex topic: plain root message, wake path launches codex, text typed once.
// The fake codex exits as soon as its ctrl+c exit key arrives.
async function liveCodexTopic(h, id = 'root-1') {
  let sleeps = 0;
  h.onRun = h.liveCodex;
  h.onKeys = (term, keys) => { if (keys.includes('ctrl+c')) term.state = 'finished'; };
  h.onSleep = () => { if (++sleeps === 2) h.ready(h.terminals.get('t1')); };
  await h.bridge.handle(message('ALPHA', id));
  return h.binding();
}

test('/engine shows one card with current CLI, group default and one button per row', async t => {
  const h = await harness(t);
  const binding = await liveCodexTopic(h);
  const before = h.cards().length;
  await h.bridge.handle(message('/engine', 'cmd-1', binding.topicId));
  const fresh = h.cards().slice(before);
  assert.equal(fresh.length, 1, 'exactly one card for the /engine prompt');
  const json = JSON.stringify(fresh[0].content);
  assert.match(json, /当前话题 CLI：Codex/);
  assert.match(json, /本群默认 CLI：Codex/);
  for (const cli of ['claude', 'codex', 'pi']) assert.ok(json.includes(`"key":"engine:${cli}"`), `button engine:${cli}`);
  assert.match(json, /Codex（当前）/);
  const card = h.store.data.actionCards.find(c => c.kind === 'engine');
  assert.equal(card.messageId, fresh[0].id);
  assert.equal(card.chatId, 'oc_test');
  assert.equal(card.topicId, binding.topicId);
  assert.ok(card.nonce);
});

test('/engine claude exits codex, launches claude in the same topic, follows the binding and remembers the group default', async t => {
  const h = await harness(t);
  const binding = await liveCodexTopic(h);
  await h.bridge.handle(message('/engine claude', 'cmd-2', binding.topicId));
  // The codex row's exit keys went to the live terminal exactly once.
  assert.deepEqual(h.keys().map(c => c.params), [{ terminal: 't1', keys: ['ctrl+c'] }]);
  assert.equal(h.terminals.get('t1').state, 'finished');
  // The new terminal is a fresh claude launch in the same cwd.
  const runs = h.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].params.line, 'claude');
  assert.equal(runs[1].params.cwd, h.cwd);
  // The binding followed the new CLI and the group default is durable.
  const current = h.binding();
  assert.equal(current.cli, 'claude');
  assert.equal(current.paneId, 'hc:t2');
  assert.equal(current.dormant, false);
  assert.equal(current.freshLaunch, null);
  assert.equal(h.store.data.groupEngines.oc_test, 'claude');
  // Exactly one result card, saying the switch happened.
  const results = h.cards().filter(c => JSON.stringify(c.content).includes('引擎已切换'));
  assert.equal(results.length, 1);
  assert.match(JSON.stringify(results[0].content), /Codex → Claude（本群新话题也用 Claude）/);
  assert.deepEqual(h.errors, []);
});

test('clicking engine:claude on the /engine card switches and patches the same card', async t => {
  const h = await harness(t);
  const binding = await liveCodexTopic(h);
  const before = h.cards().length;
  await h.bridge.handle(message('/engine', 'cmd-3', binding.topicId));
  assert.equal(h.cards().length, before + 1);
  const card = h.store.data.actionCards.find(c => c.kind === 'engine');
  h.onKeys = (term, keys) => { if (term.address === 't1' && keys.includes('ctrl+c')) term.state = 'finished'; };
  await h.bridge.handle(h.engineButton('engine:claude'));
  assert.equal(h.cards().length, before + 1, 'the button flow patches the existing card, never replies with a second one');
  const patched = h.feishu.calls.filter(c => c.type === 'patch' && c.id === card.messageId);
  assert.equal(patched.length, 1);
  assert.match(JSON.stringify(patched[0].card), /✅ 引擎已切换：Codex → Claude（本群新话题也用 Claude）/);
  assert.equal(h.binding().cli, 'claude');
  assert.equal(h.store.data.groupEngines.oc_test, 'claude');
  // The card is one-shot: a replayed click is rejected without re-running.
  await h.bridge.handle(h.engineButton('engine:pi'));
  assert.equal(h.binding().cli, 'claude');
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && String(c.content).includes('这张卡片已失效')).length, 1);
});

test('/engine with the same CLI replies 已经是 and changes nothing', async t => {
  const h = await harness(t);
  const binding = await liveCodexTopic(h);
  await h.bridge.handle(message('/engine codex', 'cmd-4', binding.topicId));
  assert.equal(h.keys().length, 0, 'no exit keys for the same CLI');
  assert.equal(h.runs().length, 1, 'no second terminal');
  const results = h.cards().filter(c => JSON.stringify(c.content).includes('已经是 Codex'));
  assert.equal(results.length, 1);
  assert.equal(h.binding().cli, 'codex');
  assert.equal(h.store.data.groupEngines.oc_test, 'codex');
});

test('/engine on a dormant topic switches the binding without exit keys', async t => {
  const h = await harness(t, { timeoutMs: 1000 });
  await h.bridge.handle(message('慢慢来', 'root-5'));
  const binding = h.binding();
  assert.equal(binding.dormant, true, 'fixture: launch timed out, topic is dormant');
  h.onRun = term => h.ready(term, 'idle', 'claude');
  await h.bridge.handle(message('/engine claude', 'cmd-5', binding.topicId));
  assert.equal(h.keys().length, 0, 'no exit procedure for a dormant topic');
  const runs = h.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].params.line, 'claude');
  const current = h.binding();
  assert.equal(current.cli, 'claude');
  assert.equal(current.sessionId, null);
  assert.equal(current.paneId, 'hc:t2');
  assert.equal(current.queuedInputs.length, 0, 'the queued text drained into the new CLI');
  assert.equal(h.sends().length, 1);
  assert.equal(h.sends()[0].params.text, '慢慢来');
  assert.equal(h.store.data.groupEngines.oc_test, 'claude');
  assert.match(JSON.stringify(h.cards().at(-1)?.content ?? {}), /引擎已切换/);
});

test('an exit that never completes leaves everything unchanged', async t => {
  const h = await harness(t);
  const binding = await liveCodexTopic(h);
  h.onKeys = () => {}; // codex ignores ctrl+c forever
  await h.bridge.handle(message('/engine claude', 'cmd-6', binding.topicId));
  assert.equal(h.keys().length, 3, 'every codex exit attempt was used within the 15 s window');
  assert.equal(h.runs().length, 1, 'claude was never launched');
  assert.equal(h.binding().cli, 'codex');
  assert.equal(h.binding().dormant, false);
  assert.ok(!h.store.data.groupEngines?.oc_test, 'the group default was not touched');
  const failed = h.cards().filter(c => JSON.stringify(c.content).includes('未做任何修改'));
  assert.equal(failed.length, 1);
  assert.equal(h.cards().filter(c => JSON.stringify(c.content).includes('引擎已切换')).length, 0);
});

test('a new topic uses the stored group engine even when the registry says otherwise', async t => {
  const h = await harness(t, { groupCli: 'codex' });
  await h.store.transaction(data => { (data.groupEngines ??= {}).oc_test = 'claude'; });
  h.onRun = term => h.ready(term, 'idle', 'claude');
  await h.bridge.handle(message('ZETA', 'root-7'));
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line, 'claude');
  assert.equal(h.binding().cli, 'claude');
});

test('an unknown engine name lists the valid names and changes nothing', async t => {
  const h = await harness(t);
  const binding = await liveCodexTopic(h);
  await h.bridge.handle(message('/engine gemini', 'cmd-8', binding.topicId));
  assert.equal(h.runs().length, 1);
  assert.equal(h.keys().length, 0);
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'text' &&
    String(c.content).includes('claude、codex、pi')).length, 1);
  assert.ok(!h.store.data.groupEngines?.oc_test);
});

test('a stale engine button nonce is rejected and changes nothing', async t => {
  const h = await harness(t);
  const binding = await liveCodexTopic(h);
  await h.bridge.handle(message('/engine', 'cmd-9', binding.topicId));
  await h.bridge.handle(h.engineButton('engine:claude', { nonce: 'stale-nonce' }));
  assert.equal(h.keys().length, 0);
  assert.equal(h.runs().length, 1);
  assert.equal(h.binding().cli, 'codex');
  assert.ok(!h.store.data.groupEngines?.oc_test);
  assert.equal(h.feishu.calls.filter(c => String(c.content).includes('这张卡片已失效')).length, 1);
});
