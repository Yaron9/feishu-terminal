import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexTranscript, codexModel } from '../src/transcripts/codex.js';
import { PiTranscript, piModel } from '../src/transcripts/pi.js';
import { CLI_TABLE, modelArgs } from '../src/cli-table.js';
import { modelKey, cleanModel } from '../src/group-model.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { Wake } from '../src/wake.js';
import { legacyHarness, message, mockFeishu } from './helpers.js';

const fixture = name => join(process.cwd(), 'test', 'fixtures', name);

// Step 1: the model comes from the transcript the CLI itself wrote, not from
// the footer screen. The fixtures are redacted real lines from this machine.
test('codex transcript extraction keeps the model and effort of its turn', async () => {
  const adapter = new CodexTranscript();
  const read = await adapter.read(fixture('w16-s5-codex.jsonl'), null);
  assert.deepEqual(read.model, { model: 'codex/gpt-6.1-terra', effort: 'medium' });
  assert.deepEqual(read.items.map(item => item.role), ['user', 'assistant', 'turn_end']);
  assert.ok(!read.items.some(item => item.role === 'model'), 'model markers stay out of transcript items');
});

test('pi transcript extraction keeps provider and model, latest observation wins', async () => {
  const adapter = new PiTranscript();
  const read = await adapter.read(fixture('w16-s5-pi.jsonl'), null);
  assert.deepEqual(read.model, { provider: 'magpie', model: 'auto/glm-5.3' });
  assert.deepEqual(read.items.map(item => item.role), ['user', 'assistant', 'turn_end']);
  // A later model_change is what the next turn really uses.
  assert.deepEqual(piModel({ type: 'model_change', provider: 'magpie', modelId: 'qwen-token-plan/qwen3.8-max' }),
    { provider: 'magpie', model: 'qwen-token-plan/qwen3.8-max' });
  assert.deepEqual(piModel({ type: 'message', message: { role: 'assistant', provider: 'magpie', model: 'auto/glm-5.3' } }),
    { provider: 'magpie', model: 'auto/glm-5.3' });
  assert.equal(piModel({ type: 'message', message: { role: 'user' } }), null);
  assert.equal(piModel({ type: 'session' }), null);
  assert.deepEqual(codexModel({ type: 'turn_context', payload: { model: 'gpt-5.1-codex-mini' } }), { model: 'gpt-5.1-codex-mini' });
  assert.equal(codexModel({ type: 'response_item', payload: { model: 'ignored' } }), null);
});

// Step 2: the row template renders into the launch/resume command, and only
// safe identifiers ever reach a command line.
test('each CLI row renders its remembered model through its own template', () => {
  const row = cli => CLI_TABLE.find(item => item.cli === cli);
  assert.equal(modelArgs(row('codex'), { model: 'gpt-5.1-codex-mini' }), '-m gpt-5.1-codex-mini');
  assert.equal(modelArgs(row('codex'), { model: 'gpt-5.1-codex-mini', effort: 'high' }),
    '-m gpt-5.1-codex-mini -c model_reasoning_effort=high');
  assert.equal(modelArgs(row('pi'), { provider: 'magpie', model: 'auto/glm-5.3' }),
    '--provider magpie --model auto/glm-5.3');
  assert.equal(modelArgs(row('pi'), { model: 'auto/glm-5.3' }), '--model auto/glm-5.3');
  assert.equal(modelArgs(row('claude'), { model: 'claude-sonnet-4-5-20250929' }), '--model claude-sonnet-4-5-20250929');
  assert.equal(modelArgs(row('codex'), null), '');
  assert.equal(modelArgs(row('codex'), { model: 'x && del /q *' }), '', 'shell metacharacters never reach a command line');
  assert.deepEqual(cleanModel({ model: 'gpt-5.1-codex-mini', effort: 'high' }), { model: 'gpt-5.1-codex-mini', effort: 'high' });
  assert.equal(cleanModel({ model: 'a b' }), null);
  assert.equal(cleanModel({ provider: 'magpie' }), null);
});

// Step 3a: recording happens when a turn completes, from the transcript.
test('a completed turn records the model for its group and CLI', async t => {
  const records = []; let observed = null;
  const adapter = {
    locate: async () => 'w16s5-turns.jsonl',
    read: async (_path, cursor) => ({ cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
      ...(observed ? { model: observed } : {}) }),
  };
  const h = await legacyHarness(t, { adapters: { codex: adapter } });
  const pane = h.fake.create(); pane.agent = 'codex'; pane.agent_status = 'working';
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const binding = () => h.bridge.store.forPane('w1:p1');
  assert.equal(binding().cli, 'codex');
  const poll = async (ms = 0) => { h.advance(ms); h.bridge.state(binding()).dirty = true; await h.bridge.tick(); };

  observed = { model: 'gpt-5.1-codex-mini', effort: 'high' };
  records.push({ role: 'assistant', text: 'M1' });
  await poll();
  assert.equal(h.store.data.groupModels?.oc_test?.codex, undefined, 'a running turn has not completed yet');
  pane.agent_status = 'done';
  await poll(2000);
  assert.deepEqual(h.store.data.groupModels.oc_test.codex, { model: 'gpt-5.1-codex-mini', effort: 'high' });

  // A /model pick in the terminal shows up on the next turn's transcript.
  pane.agent_status = 'working';
  records.push({ role: 'assistant', text: 'M2' });
  observed = { model: 'gpt-5.6-luna' };
  await poll();
  pane.agent_status = 'done';
  await poll(2000);
  assert.deepEqual(h.store.data.groupModels.oc_test.codex, { model: 'gpt-5.6-luna' });
});

// Step 3b: launch and resume read that memory; other groups stay unchanged.
async function harness(t, { groupCli = 'codex' } = {}) {
  const home = await mkdtemp(join(process.cwd(), '.test-w16s5-'));
  const cwd = 'C:\\fixture\\project';
  let time = Date.now(), sequence = 0;
  const now = () => time, terminals = new Map(), calls = [], errors = [];
  const h = { home, cwd, calls, terminals, errors, onRun: () => {}, onSleep: () => {} };
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
  const config = { chatIds: ['oc_test', 'oc_other'], operatorOpenIds: ['ou_test'], defaultCwd: 'C:\\fixture\\default',
    groups: { oc_test: { cwd, ...(groupCli ? { cli: groupCli } : {}) }, oc_other: { cwd, ...(groupCli ? { cli: groupCli } : {}) } } };
  const bridge = new Bridge({ backend, feishu, store, config, now, adapters: {}, sessionFollow: follow,
    audit: async () => {}, onError: error => errors.push(error),
    wakeOptions: { timeoutMs: 20000, sleep: async ms => { time += ms; await h.onSleep(); } } });
  Object.assign(h, { store, feishu, backend, bridge, config, create,
    advance(ms = 2000) { time += ms; },
    runs: () => calls.filter(c => c.method === 'terminal.run'),
    sends: () => calls.filter(c => c.method === 'terminal.send'),
    ready(term, state = 'idle', app = 'codex') { term.reported = true; term.status = { app, state }; },
    binding: (chatId = 'oc_test') => store.list().find(b => b.chatId === chatId),
  });
  t.after(async () => { await bridge.stop(); await rm(home, { recursive: true, force: true }); });
  return h;
}

const codexLaunch = CLI_TABLE.find(row => row.cli === 'codex').launch;

test('a new topic launches with the group model; a group without memory is unchanged', async t => {
  const h = await harness(t);
  h.store.data.groupModels = { oc_test: { codex: { model: 'gpt-5.1-codex-mini' } } };
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('只回复 M2', 'root-model', 'root-model'));
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line, `${codexLaunch} -m gpt-5.1-codex-mini`);
  assert.deepEqual(h.errors, []);
});

test('no remembered model leaves the codex launch unchanged', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('只回复 M2', 'root-plain', 'root-plain'));
  assert.equal(h.runs()[0].params.line, codexLaunch);
});

test('a resumed topic reapplies the remembered model and effort', async t => {
  const h = await harness(t);
  await h.store.bind({ chatId: 'oc_test', topicId: 'resume-topic', paneId: 'pending:resume-topic', identity: null,
    cli: 'codex', cwd: h.cwd, sessionId: 'same-session', sessionSource: 'probe', cliCommand: codexLaunch,
    dormant: true, queuedInputs: [{ id: randomUUID(), type: 'input', text: 'again' }] });
  h.store.data.groupModels = { oc_test: { codex: { model: 'gpt-5.1-codex-mini', effort: 'high' } } };
  h.onRun = term => h.ready(term);
  await h.bridge.wake.ensure(h.store.list()[0]);
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line,
    'codex resume same-session --no-daemon -c check_for_update_on_startup=false -m gpt-5.1-codex-mini -c model_reasoning_effort=high');
});

test('pi launch and resume use its provider/model template', async t => {
  const h = await harness(t, { groupCli: 'pi' });
  h.store.data.groupModels = { oc_test: { pi: { provider: 'magpie', model: 'auto/glm-5.3' } } };
  h.onRun = term => h.ready(term, 'idle', 'pi');
  await h.bridge.handle(message('hello', 'root-pi', 'root-pi'));
  assert.equal(h.runs()[0].params.line, 'pi --provider magpie --model auto/glm-5.3');

  const h2 = await harness(t, { groupCli: 'pi' });
  await h2.store.bind({ chatId: 'oc_test', topicId: 'pi-resume', paneId: 'pending:pi-resume', identity: null,
    cli: 'pi', cwd: h2.cwd, sessionId: 'pi-session', sessionSource: 'probe', cliCommand: 'pi',
    dormant: true, queuedInputs: [{ id: randomUUID(), type: 'input', text: 'again' }] });
  h2.store.data.groupModels = { oc_test: { pi: { provider: 'magpie', model: 'auto/glm-5.3' } } };
  h2.onRun = term => h2.ready(term, 'idle', 'pi');
  await h2.bridge.wake.ensure(h2.store.list()[0]);
  assert.equal(h2.runs()[0].params.line, 'pi --session pi-session --provider magpie --model auto/glm-5.3');
});

// Step 3c: member topics key separately; another group never sees this one.
test('member bindings key by chat plus member and other groups stay unchanged', async t => {
  assert.equal(modelKey('oc_test', { member: 'm-7' }), 'oc_test:m-7');
  assert.equal(modelKey('oc_test', { member: { id: 'm-7' } }), 'oc_test:m-7');
  assert.equal(modelKey('oc_test', {}), 'oc_test');

  const h = await harness(t);
  h.store.data.groupModels = {
    'oc_test:m-7': { codex: { model: 'gpt-5.1-codex-mini' } },
    oc_test: { codex: { model: 'gpt-5.6-luna' } },
  };
  await h.store.bind({ chatId: 'oc_test', topicId: 'member-topic', paneId: 'pending:member', identity: null,
    member: 'm-7', cli: 'codex', cwd: h.cwd, sessionId: null, cliCommand: codexLaunch, freshLaunch: true,
    dormant: true, queuedInputs: [{ id: randomUUID(), type: 'input', text: 'member' }] });
  await h.store.bind({ chatId: 'oc_test', topicId: 'plain-topic', paneId: 'pending:plain', identity: null,
    cli: 'codex', cwd: h.cwd, sessionId: null, cliCommand: codexLaunch, freshLaunch: true,
    dormant: true, queuedInputs: [{ id: randomUUID(), type: 'input', text: 'plain' }] });
  await h.store.bind({ chatId: 'oc_other', topicId: 'other-topic', paneId: 'pending:other', identity: null,
    cli: 'codex', cwd: h.cwd, sessionId: null, cliCommand: codexLaunch, freshLaunch: true,
    dormant: true, queuedInputs: [{ id: randomUUID(), type: 'input', text: 'other' }] });
  h.onRun = term => h.ready(term);
  for (const binding of h.store.list()) await h.bridge.wake.ensure(binding);
  const lines = h.runs().map(run => run.params.line).sort();
  assert.deepEqual(lines, [
    codexLaunch,
    `${codexLaunch} -m gpt-5.1-codex-mini`,
    `${codexLaunch} -m gpt-5.6-luna`,
  ].sort(), 'member, group-default and other-group launches each get their own memory');
});

// A command the user typed keeps exactly what it already contains.
test('a user-supplied CLI command is never decorated', async t => {
  const home = await mkdtemp(join(process.cwd(), '.test-w16s5-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await new Store(join(home, 'state.json')).load();
  await store.bind({ chatId: 'c', topicId: 't', paneId: 'hc:old', identity: { terminalId: 'old' },
    cli: 'codex', cwd: 'C:\\fixture\\project', sessionId: null, cliCommand: 'codex -m gpt-6-astra', freshLaunch: true,
    dormant: true, queuedInputs: [{ id: 'q', type: 'input', text: 'again' }] });
  store.data.groupModels = { c: { codex: { model: 'gpt-5.1-codex-mini' } } };
  let command;
  const terminal = { pane_id: 'hc:new', terminal_id: 'new', status: { state: 'done' } };
  const b = { store, now: Date.now, stopped: false, sameGeneration: (a, c) => a?.generation === c?.generation,
    updateGeneration: async (binding, patch) => store.update(binding.chatId, binding.topicId, patch),
    modelFor: binding => store.data.groupModels?.[modelKey(binding.chatId, binding)]?.[binding.cli] ?? null,
    feishu: { reply: async () => {} }, tree: { parent: () => null }, sessionFollow: { candidates: async () => [] },
    registry: { get: () => ({}) },
    backend: { backends: new Map([['hc', { list: async () => [], create: async line => { command = line; return terminal; } }]]),
      identity: () => ({ terminalId: 'new' }), get: async () => terminal },
    runtime: new Map(), verify: async () => {}, resubscribe: () => {},
    input: async (_binding, _text, _a, _b, claim) => { await claim(); return true; }, writeInput: async () => {} };
  await new Wake(b).ensure(store.list()[0]);
  assert.equal(command, 'codex -m gpt-6-astra');
});