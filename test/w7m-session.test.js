import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionFollow } from '../src/session-follow.js';
import { Store } from '../src/store.js';
import { Wake } from '../src/wake.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'w7m-')); t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.codex', 'sessions', '2026', '11', '05'); await mkdir(dir, { recursive: true });
  const time = Date.now() - 1000;
  await writeFile(join(dir, 'rollout-test-shared.jsonl'), JSON.stringify({ type: 'session_meta', timestamp: new Date(time).toISOString(), payload: { session_id: 'shared', cwd: '/project' } }) + '\n');
  const follow = new SessionFollow({ home });
  const terms = [1, 2, 3].map(n => ({ pane_id: `hc:t${n}`, created_ms: time - 5000, agent: 'codex', foreground: { pid: n, argv: ['codex'], cwd: '/project' } }));
  follow.backend = { backends: new Map([['hc', { list: async () => terms }]]), processOf: x => x.foreground.pid, identity: x => ({ terminalId: x.pane_id }) };
  return { home, time, follow, terms };
}

test('a cwd probe assigns only a single eligible binding and never supplies follow candidates', async t => {
  const { home, time, follow, terms } = await fixture(t);
  const store = await new Store(join(home, 'state.json')).load();
  for (let i = 0; i < 3; i++) await store.bind({ chatId: 'c', topicId: `topic${i}`, paneId: terms[i].pane_id, identity: { terminalId: terms[i].pane_id }, cli: 'codex', cwd: '/project', sentInputs: i === 2 ? [{ terminalId: terms[i].pane_id, sentAt: time - 100, prefix: 'codex' }] : [] });
  const b = { store, backend: follow.backend, sessionFollow: follow, now: () => time + 10000, updateGeneration: async (binding, patch) => store.update(binding.chatId, binding.topicId, patch), state: () => ({}), tree: { observe: async () => {} }, sessionIdentity: () => ({}), sameGeneration: (a, c) => a?.generation === c?.generation };
  const wake = new Wake(b);
  for (let i = 0; i < 3; i++) await wake.observe(store.list()[i], terms[i]);
  assert.deepEqual(store.list().map(x => x.sessionId ?? null), [null, null, 'shared']);
  assert.equal(store.list()[2].sessionSource, 'probe');
  assert.deepEqual(await follow.candidates('shared'), []);
  assert.equal((await follow.describe(terms[0])).sessionVerified, false);
});

test('a sole terminal claims a recent session without input or timestamp', async t => {
  const { home, time, follow, terms } = await fixture(t);
  const file = join(home, '.codex', 'sessions', '2026', '11', '05', 'rollout-test-shared.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { session_id: 'shared', cwd: '/project' } }) + '\n');
  follow.backend.backends.get('hc').list = async () => [terms[0]];
  const store = await new Store(join(home, 'state.json')).load();
  await store.bind({ chatId: 'c', topicId: 'one', paneId: terms[0].pane_id, identity: { terminalId: terms[0].pane_id }, cli: 'codex', cwd: '/project' });
  const b = { store, backend: follow.backend, sessionFollow: follow, now: () => time + 10000,
    updateGeneration: async (binding, patch) => store.update(binding.chatId, binding.topicId, patch), state: () => ({}),
    tree: { observe: async () => {} }, sessionIdentity: () => ({}), sameGeneration: (a, c) => a?.generation === c?.generation };
  await new Wake(b).observe(store.list()[0], terms[0]);
  assert.equal(store.list()[0].sessionId, 'shared'); assert.equal(store.list()[0].sessionSource, 'probe');
});

test('late shared binding keeps its id and both wakes use one launch', async t => {
  const { home } = await fixture(t), store = await new Store(join(home, 'state.json')).load();
  for (const n of [1, 2]) await store.bind({ chatId: 'c', topicId: `t${n}`, paneId: `hc:old${n}`, generation: `g${n}`,
    identity: { terminalId: `old${n}` }, cli: 'codex', cwd: '/project', sessionId: 'shared', sessionSource: 'probe', dormant: true,
    queuedInputs: [{ id: `input${n}`, type: 'input', text: `message${n}` }] });
  let launches = 0; const live = [];
  const terminal = { pane_id: 'hc:new', terminal_id: 'new', status: { state: 'idle' } };
  const b = { store, now: Date.now, stopped: false, sameGeneration: (a, c) => a?.generation === c?.generation,
    updateGeneration: async (binding, patch) => store.update(binding.chatId, binding.topicId, patch),
    feishu: { reply: async () => {} }, tree: { parent: () => null },
    sessionFollow: { candidates: async () => live.map(() => ({ terminalId: 'hc:new' })), terminal: () => terminal },
    backend: { backends: new Map([['hc', { list: async () => live, create: async () => { launches++; live.push(terminal); return terminal; } }]]),
      identity: () => ({ terminalId: 'new' }), get: async () => terminal },
    runtime: new Map(), verify: async () => {}, resubscribe: () => {}, input: async (binding, text, staged, first, claim) => { await claim(); await store.update(binding.chatId, binding.topicId, { needs_check: false }); return true; } };
  const wake = new Wake(b); await Promise.all(store.list().map(binding => wake.ensure(binding)));
  assert.equal(launches, 1); assert.deepEqual(store.list().map(x => x.sessionId), ['shared', 'shared']);
  assert.equal(store.binding('c', 't2').queuedInputs.length, 1);
});

test('verified argv duplicates remain candidates', async t => {
  const { follow, terms } = await fixture(t);
  for (const term of terms.slice(0, 2)) term.foreground.argv = ['codex', 'resume', 'shared'];
  assert.equal((await follow.candidates('shared')).length, 2);
  assert.equal((await follow.describe(terms[0])).sessionVerified, true);
});

test('shared persisted ids are removed and wake replays the command without resume', async t => {
  const { home } = await fixture(t), file = join(home, 'persist.json');
  const bindings = [1, 2].map(n => ({ chatId: 'c', topicId: `t${n}`, paneId: `hc:t${n}`, generation: `g${n}`, identity: { terminalId: `t${n}` }, cli: 'codex', cwd: '/project', sessionId: 'shared', sessionSource: 'probe', cliCommand: 'codex --no-daemon', dormant: true }));
  await writeFile(file, JSON.stringify({ version: 2, bindings, seen: [] }));
  const store = await new Store(file).load(); assert.deepEqual(store.list().map(x => x.sessionId), [null, null]);
  let command; const terminal = { pane_id: 'hc:new', terminal_id: 'new', status: { state: 'idle' } };
  const b = { store, now: Date.now, stopped: false, sameGeneration: (a, c) => a?.generation === c?.generation,
    updateGeneration: async (binding, patch) => store.update(binding.chatId, binding.topicId, patch),
    feishu: { reply: async () => {} }, tree: { parent: () => null }, sessionFollow: { candidates: async () => [] },
    backend: { backends: new Map([['hc', { list: async () => [], create: async line => { command = line; return terminal; } }]]), identity: () => ({ terminalId: 'new' }), get: async () => terminal },
    runtime: new Map(), verify: async () => {}, resubscribe: () => {} };
  const wake = new Wake(b); await wake.ensure(store.list()[0]); assert.equal(command, 'codex --no-daemon');
});

test('Claude pid file remains verified', async t => {
  const { home, follow } = await fixture(t), dir = join(home, '.claude', 'sessions'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '42.json'), JSON.stringify({ pid: 42, sessionId: 'claude-id' }));
  const facts = await follow.describe({ pane_id: 'hc:t42', agent: 'claude', foreground: { pid: 42, cwd: '/project', argv: ['claude'] } });
  assert.equal(facts.sessionId, 'claude-id'); assert.equal(facts.sessionVerified, true);
});
