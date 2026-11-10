import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_TABLE, shellQuote, instructionsArg } from '../src/cli-table.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { Wake } from '../src/wake.js';
import { mockFeishu, message } from './helpers.js';

const expectedQuote = file => process.platform === 'win32' ? `"${file}"` : `'${file}'`;

test('shellQuote groups a path for the target shell', () => {
  // cmd.exe (`%COMSPEC% /d /s /c`) only groups an argument in double quotes;
  // single quotes are literal there. POSIX `sh -c` groups in single quotes.
  assert.equal(shellQuote('C:\\project dir\\SOUL.md'), expectedQuote('C:\\project dir\\SOUL.md'));
  if (process.platform !== 'win32') assert.equal(shellQuote(`a'b`), `'a'\\''b'`);
});

test('instructionsArg quotes an existing file and ignores rows without a template', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.test-w16s3-arg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'persona file.md'); await writeFile(file, 'persona');
  const pi = CLI_TABLE.find(row => row.cli === 'pi');
  const codex = CLI_TABLE.find(row => row.cli === 'codex');
  assert.equal(await instructionsArg(pi, file), `--append-system-prompt ${shellQuote(file)}`);
  assert.equal(await instructionsArg(codex, file), null, 'codex has no instructions template');
  assert.equal(await instructionsArg(pi, null), null);
  assert.equal(await instructionsArg(pi, join(dir, 'missing.md')), null);
});

// Fake hc backend: terminal.run records the exact command line; nothing is
// ever executed. Shell creates arrive without a line, CLI wakes with one.
async function harness(t, { groupCli = 'pi', instructionsFile = null } = {}) {
  const home = await mkdtemp(new URL('../.test-w16s3-', import.meta.url));
  const cwd = 'C:\\fixture\\project';
  let time = Date.now(), sequence = 0;
  const now = () => time, terminals = new Map(), calls = [], audits = [], errors = [];
  const h = { home, cwd, calls, terminals, audits, errors, onRun: () => {}, onSleep: () => {} };
  const create = (props = {}) => {
    const address = `t${++sequence}`, pid = 1000 + sequence;
    const terminal = { address, pid, created_ms: time + sequence, state: 'live', cwd: props.cwd ?? cwd, labels: {},
      foreground: { pid, name: 'cmd.exe', argv: ['cmd.exe', '/c', props.line ?? 'powershell.exe'], cwd: props.cwd ?? cwd },
      reported: false, status: null, output: 'ready.', ...props };
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
    groups: { oc_test: { cwd, ...(groupCli ? { cli: groupCli } : {}), ...(instructionsFile ? { instructionsFile } : {}) } } };
  const bridge = new Bridge({ backend, feishu, store, config, now, adapters: {}, sessionFollow: follow,
    audit: async record => audits.push(record), onError: error => errors.push(error),
    wakeOptions: { timeoutMs: 20000, sleep: async ms => { time += ms; await h.onSleep(); } } });
  Object.assign(h, { store, feishu, backend, bridge, config, create,
    advance(ms = 2000) { time += ms; },
    runs: () => calls.filter(c => c.method === 'terminal.run'),
    sends: () => calls.filter(c => c.method === 'terminal.send'),
    ready(term, state = 'done', app = 'pi') { term.reported = true; term.status = { app, state }; },
    binding: () => store.list()[0],
  });
  t.after(async () => { await bridge.stop(); await rm(home, { recursive: true, force: true }); });
  return h;
}

test('pi launch passes the quoted persona file and stores it on the binding', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.test-w16s3-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'persona dir.md'); await writeFile(file, 'persona');
  const h = await harness(t, { groupCli: 'pi', instructionsFile: file });
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('你叫什么？只答名字', 'root-1'));
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line, `pi --append-system-prompt ${shellQuote(file)}`);
  assert.equal(h.runs()[0].params.cwd, h.cwd);
  assert.equal(h.binding().instructionsFile, file, 'binding keeps the file for restarts');
  assert.equal(h.binding().cli, 'pi');
  assert.equal(h.sends().length, 1);
  assert.equal(h.sends()[0].params.text, '你叫什么？只答名字');
  assert.deepEqual(h.errors, []);
});

test('without instructionsFile the pi command is unchanged', async t => {
  const h = await harness(t, { groupCli: 'pi' });
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('hello', 'root-2'));
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line, 'pi');
  assert.equal(h.binding().instructionsFile, null);
});

test('codex and claude launches are unchanged even with an instructionsFile', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.test-w16s3-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'persona.md'); await writeFile(file, 'persona');
  for (const [cli, line] of [['codex', CLI_TABLE.find(row => row.cli === 'codex').launch], ['claude', 'claude']]) {
    const h = await harness(t, { groupCli: cli, instructionsFile: file });
    h.onRun = term => h.ready(term, 'idle', cli);
    await h.bridge.handle(message('hello', `root-${cli}`));
    assert.equal(h.runs().length, 1, cli);
    assert.equal(h.runs()[0].params.line, line, cli);
    assert.equal(h.binding().instructionsFile, file, `${cli} still stores the file`);
  }
});

// Minimal wake bridge for resume command construction, without a full Bridge.
async function wakeFixture(t, { bindingInstructionsFile, registryInstructionsFile, sessionId = 'same-session' }) {
  const home = await mkdtemp(join(process.cwd(), '.test-w16s3-wake-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await new Store(join(home, 'state.json')).load();
  await store.bind({ chatId: 'c', topicId: 't1', paneId: 'hc:old', generation: 'g1', identity: { terminalId: 'old' },
    cli: 'pi', cwd: 'C:\\fixture\\project', sessionId, sessionSource: 'probe', cliCommand: 'pi',
    instructionsFile: bindingInstructionsFile, dormant: true, queuedInputs: [{ id: 'q1', type: 'input', text: 'again' }] });
  let command;
  const terminal = { pane_id: 'hc:new', terminal_id: 'new', status: { state: 'done' } };
  const b = { store, now: Date.now, stopped: false, sameGeneration: (a, c) => a?.generation === c?.generation,
    updateGeneration: async (binding, patch) => store.update(binding.chatId, binding.topicId, patch),
    feishu: { reply: async () => {} }, tree: { parent: () => null }, sessionFollow: { candidates: async () => [] },
    registry: { get: () => ({ instructionsFile: registryInstructionsFile }) },
    backend: { backends: new Map([['hc', { list: async () => [], create: async line => { command = line; return terminal; } }]]),
      identity: () => ({ terminalId: 'new' }), get: async () => terminal },
    runtime: new Map(), verify: async () => {}, resubscribe: () => {}, input: async (_binding, _text, _a, _b, claim) => { await claim(); return true; }, writeInput: async () => {} };
  await new Wake(b).ensure(store.list()[0]);
  return command;
}

test('pi resume re-passes the quoted persona file from the binding', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.test-w16s3-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'persona file.md'); await writeFile(file, 'persona');
  const command = await wakeFixture(t, { bindingInstructionsFile: file });
  assert.equal(command, `pi --session same-session --append-system-prompt ${shellQuote(file)}`);
});

test('pi resume falls back to the registry file when the binding has none', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.test-w16s3-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'persona.md'); await writeFile(file, 'persona');
  const command = await wakeFixture(t, { bindingInstructionsFile: null, registryInstructionsFile: file });
  assert.equal(command, `pi --session same-session --append-system-prompt ${shellQuote(file)}`);
});

test('a restart keeps instructionsFile on the binding', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.test-w16s3-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'persona.md'); await writeFile(file, 'persona');
  const h = await harness(t, { groupCli: 'pi', instructionsFile: file });
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('first', 'root-3'));
  assert.equal(h.binding().instructionsFile, file);
  const restored = await new Store(h.store.file).load();
  assert.equal(restored.list()[0].instructionsFile, file, 'instructionsFile survives a store reload');
});
