import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_TABLE } from '../src/cli-table.js';
import { createConfigRegistry } from '../src/registry.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { mockFeishu, message } from './helpers.js';

test('group registry preserves optional default CLI and instructions path', () => {
  const registry = createConfigRegistry({ chatIds: ['one', 'two'], groups: {
    one: { cli: 'codex', instructionsFile: 'C:\\project\\SOUL.md' },
  } });
  assert.equal(registry.get('one').cli, 'codex');
  assert.equal(registry.get('one').instructionsFile, 'C:\\project\\SOUL.md');
  assert.equal(registry.get('two').cli, undefined);
});

test('CLI rows declare their interactive launch command', () => {
  assert.equal(CLI_TABLE.find(row => row.cli === 'codex').resume, 'codex resume {id} --no-daemon -c check_for_update_on_startup=false');
  assert.deepEqual(CLI_TABLE.map(({ cli, launch }) => [cli, launch]), [
    ['claude', 'claude'], ['codex', 'codex --no-daemon -c check_for_update_on_startup=false'], ['pi', 'pi'],
  ]);
});

// Fake hc backend: terminal.run records the exact command line; nothing is
// ever executed. Shell creates arrive without a line, CLI wakes with one.
async function harness(t, { groupCli = 'codex', timeoutMs = 20000 } = {}) {
  const home = await mkdtemp(new URL('../.test-w16-', import.meta.url));
  const cwd = 'C:\\fixture\\project';
  let time = Date.now(), sequence = 0;
  const now = () => time, terminals = new Map(), calls = [], audits = [], errors = [];
  const h = { home, cwd, calls, terminals, audits, errors, onRun: () => {}, onSleep: () => {} };
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
      if (method === 'terminal.send' || method === 'terminal.keys') return { turn: 0 };
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
    wakeOptions: { timeoutMs, sleep: async ms => { time += ms; await h.onSleep(); } } });
  Object.assign(h, { store, feishu, backend, bridge, config, create,
    advance(ms = 2000) { time += ms; },
    sends: () => calls.filter(c => c.method === 'terminal.send'),
    runs: () => calls.filter(c => c.method === 'terminal.run'),
    ready(term, state = 'idle', app = 'codex') { term.reported = true; term.status = { app, state }; },
    binding: () => store.list()[0],
  });
  t.after(async () => { await bridge.stop(); await rm(home, { recursive: true, force: true }); });
  return h;
}

test('plain root message with group cli codex launches codex directly, no shell pane, text typed once after ready', async t => {
  const h = await harness(t);
  let sleeps = 0;
  h.onSleep = () => { assert.equal(h.sends().length, 0, 'text must never be sent before the CLI is ready'); if (++sleeps === 2) h.ready(h.terminals.get('t1')); };
  await h.bridge.handle(message('帮我看看这个项目', 'root-1'));
  // Exactly one hc create: the CLI launch in the group cwd, never a shell pane.
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line, 'codex --no-daemon -c check_for_update_on_startup=false');
  assert.equal(h.runs()[0].params.cwd, h.cwd);
  assert.deepEqual(h.runs()[0].params.labels, { 'ft.woken': '1', source: 'feishu-terminal' });
  // The queued text is written exactly once, only after ready.
  assert.equal(h.sends().length, 1);
  assert.equal(h.sends()[0].params.text, '帮我看看这个项目');
  assert.equal(h.sends()[0].params.terminal, 't1');
  const binding = h.binding();
  assert.equal(binding.paneId, 'hc:t1');
  assert.equal(binding.dormant, false);
  assert.equal(binding.freshLaunch, null);
  assert.equal(binding.cli, 'codex');
  assert.deepEqual(binding.queuedInputs, []);
  assert.equal(binding.needs_check, false);
  assert.equal(binding.topicId, 'root-1');
  assert.equal(binding.topicRoot.type, 'user');
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
  assert.equal(h.store.data.topicPointers?.length ?? 0, 0);
  assert.equal(h.feishu.calls.filter(c => String(c.content).includes('\u5df2\u5728\u65b0\u8bdd\u9898')).length, 0);
  assert.equal(h.audits.filter(a => a.action === 'first_input').length, 1);
  h.advance(); await h.bridge.tick();
  const topicCards = h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive' && c.topicId === binding.topicId);
  assert.equal(topicCards.length, 1);
  assert.match(JSON.stringify(topicCards[0].content), /\u4f1a\u8bdd\uff1a/);
  assert.deepEqual(h.errors, []);
});

test('quotes, ; and && in the root text never reach the create command line', async t => {
  const h = await harness(t);
  const text = 'run "whoami"; echo a && b `id` | tee C:\\tmp\\x & del /q *';
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message(text, 'root-2'));
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line, 'codex --no-daemon -c check_for_update_on_startup=false');
  assert.ok(!JSON.stringify(h.runs()[0].params).includes('whoami'));
  assert.equal(h.sends().length, 1);
  assert.equal(h.sends()[0].params.text, text);
});

test('root text that is itself a CLI start keeps the shell path even with group cli codex', async t => {
  const h = await harness(t);
  await h.bridge.handle(message('pi', 'root-3'));
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line, undefined, 'shell pane, no command line');
  assert.equal(h.sends().length, 1);
  assert.equal(h.sends()[0].params.text, 'pi');
  const binding = h.binding();
  assert.ok(!binding.dormant);
  assert.equal(binding.freshLaunch, undefined);
  assert.equal(binding.topicId, 'root-3');
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
});

test('without a group cli a plain message keeps the shell path', async t => {
  const h = await harness(t, { groupCli: null });
  await h.bridge.handle(message('hello there', 'root-4'));
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line, undefined);
  assert.equal(h.sends().length, 1);
  assert.equal(h.sends()[0].params.text, 'hello there');
  assert.ok(!h.binding().dormant);
  assert.equal(h.binding().cli, null);
  assert.equal(h.binding().topicId, 'root-4');
  h.advance(); await h.bridge.tick();
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
  const cards = h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive');
  assert.equal(cards.length, 1);
  assert.match(JSON.stringify(cards[0].content), /\u4f1a\u8bdd\uff1a/);
  assert.ok(!h.feishu.calls.some(c => String(c.content).includes('\u5df2\u5728\u65b0\u8bdd\u9898')));
  await h.store.update('oc_test', 'root-4', { sessionTitle: 'Changed', sessionId: 'session-id' });
  h.advance(120000); await h.bridge.tick();
  assert.ok(!h.feishu.calls.some(c => c.type === 'patch' && c.id === 'root-4'));
  const restored = await new Store(join(h.home, 'state.json')).load();
  assert.equal(restored.binding('oc_test', 'root-4').topicRoot.type, 'user');
});

test('launch timeout leaves the text queued and shows the existing wake screen card', async t => {
  const h = await harness(t, { timeoutMs: 1000 });
  await h.bridge.handle(message('慢慢来', 'root-5'));
  const binding = h.binding();
  assert.equal(h.runs().length, 1, 'launched exactly once');
  assert.equal(h.sends().length, 0, 'text never typed into an unready CLI');
  assert.equal(binding.dormant, true);
  assert.equal(binding.freshLaunch, true);
  assert.equal(binding.queuedInputs.length, 1);
  assert.equal(binding.queuedInputs[0].text, '慢慢来');
  assert.ok(binding.wakeCardId);
  const card = h.feishu.calls.find(c => c.id === binding.wakeCardId);
  assert.equal(card.msgType, 'interactive');
  assert.match(JSON.stringify(card.content), /Update available/);
  assert.match(JSON.stringify(card.content), /唤醒仍在等待确认/);
});



test('resume migration keeps its pointer to the existing topic', async t => {
  const h = await harness(t, { groupCli: null });
  await h.bridge.handle(message('hello', 'original'));
  await h.store.update('oc_test', 'original', { claudeSessionId: 'same' });
  await h.bridge.handle(message('claude --resume same', 'resume-request'));
  assert.equal(h.store.list().length, 1);
  assert.ok(h.store.data.topicPointers.some(p => p.oldTopicId === 'resume-request' && p.topicId === 'original'));
  assert.ok(h.feishu.calls.some(c => c.type === 'reply' && c.topicId === 'resume-request' && String(c.content).includes('\u5df2\u5728\u65b0\u8bdd\u9898')));
});


test('a slow fresh CLI reuses its waiting card for the first input', async t => {
  const h = await harness(t, { timeoutMs: 1000 });
  await h.bridge.handle(message('slow request', 'slow-root'));
  const waiting = h.binding().wakeCardId;
  assert.ok(waiting);
  h.ready(h.terminals.get('t1'));
  await h.bridge.wake.ensure(h.binding());
  h.advance(); await h.bridge.tick();
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive').length, 1);
  assert.equal(h.binding().cardId, waiting);
  assert.ok(h.feishu.calls.some(c => c.type === 'patch' && c.id === waiting));
});

test('CLI root reuses an already published startup card for its first interaction', async t => {
  const h = await harness(t);
  const original = h.bridge.input.bind(h.bridge);
  h.bridge.input = async (...args) => {
    const binding = args[0];
    const id = await h.feishu.reply(binding.topicId, { schema: '2.0' }, 'interactive');
    await h.store.update(binding.chatId, binding.topicId, { cardId: id });
    return original(...args);
  };
  await h.bridge.handle(message('codex', 'cli-root'));
  const term = h.terminals.get('t1');
  h.ready(term); term.agent = 'codex'; term.output = 'Codex ready';
  h.advance(); await h.bridge.tick();
  const cards = h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive');
  assert.equal(cards.length, 1);
});
