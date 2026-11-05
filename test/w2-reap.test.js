import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { CLI_TABLE } from '../src/cli-table.js';
import { mockFeishu, message } from './helpers.js';

async function harness(t, { cli = 'pi', idleMinutes, labels = { 'ft.woken': '1', session: 'same' }, unbound = false } = {}) {
  const root = await mkdtemp(new URL('../.test-w2-reap-', import.meta.url));
  let time = Date.now(), sequence = 0;
  const now = () => time, calls = [], terminals = new Map(), errors = [];
  const h = { onKeys: () => {}, onGet: () => {}, onRead: () => {}, exitAfter: cli === 'codex' ? 2 : 1,
    failKeys: false, failRemove: false, loseRemove: false, listDown: false };
  const create = props => {
    const address = `t${++sequence}`, pid = 1000 + sequence;
    const terminal = { address, pid, cwd: root, created_ms: sequence, turn: 0, status_ms: 0,
      state: 'live', foreground: { pid, name: 'cmd.exe', cwd: root }, labels,
      reported: true, status: { app: cli === 'claude' ? 'claude-code' : cli, state: 'done' },
      output: '❯ ', ...props };
    terminals.set(address, terminal); return terminal;
  };
  const client = {
    async request(method, params, hello) {
      calls.push({ method, params }); hello?.({ core: { id: 'fixture-core' } });
      if (method === 'terminal.list') {
        if (h.listDown) throw Object.assign(new Error('offline'), { code: 'unavailable' });
        return { terminals: [...terminals.values()] };
      }
      if (method === 'terminal.run') return create({ labels: params.labels, status: { app: cli, state: 'idle' } });
      const term = terminals.get(params.terminal);
      if (!term) throw Object.assign(new Error('gone'), { code: 'not_found' });
      if (method === 'terminal.get') { await h.onGet(term); return term; }
      if (method === 'terminal.read') { await h.onRead(term); return { text: term.output }; }
      if (method === 'terminal.keys') {
        await h.onKeys(term);
        if (h.failKeys) throw Object.assign(new Error('lost'), { code: 'connection_closed' });
        if (calls.filter(c => c.method === 'terminal.keys' && c.params.terminal === term.address).length >= h.exitAfter) term.state = 'finished';
        return { turn: term.turn };
      }
      if (method === 'terminal.send') { term.turn++; term.status_ms = time; return { turn: term.turn }; }
      if (method === 'terminal.rm') {
        assert.equal(term.state, 'finished', 'never remove a live terminal');
        if (h.failRemove) { h.failRemove = false; throw Object.assign(new Error('offline'), { code: 'unavailable' }); }
        terminals.delete(term.address);
        if (h.loseRemove) { h.loseRemove = false; throw Object.assign(new Error('lost'), { code: 'connection_closed' }); }
        return { removed: term.address };
      }
      throw new Error(`unexpected ${method}`);
    }, subscribe() { return () => {}; }, close() {},
  };
  const backend = new Backends([new HcBackend(client)]), terminal = create();
  const store = await new Store(join(root, 'state.json')).load(), feishu = mockFeishu(now);
  const config = { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: root,
    sessionFollow: 'warn', ...(idleMinutes === undefined ? {} : { idleMinutes }) };
  const follow = new SessionFollow({ home: root, procRoot: join(root, 'absent') });
  const bridge = new Bridge({ backend, feishu, store, config, now, sessionFollow: follow, adapters: {},
    audit: async () => {}, onError: code => errors.push(code),
    reapOptions: { waitMs: 200, sleep: async ms => { time += ms; } },
    wakeOptions: { timeoutMs: 1000, sleep: async ms => { time += ms; } } });
  const identity = backend.identity(await backend.get('hc:t1'));
  if (!unbound) await store.bind({ chatId: 'oc_test', topicId: 'topic', paneId: 'hc:t1', identity,
    cli, cwd: root, sessionId: 'same', dormant: false });
  else await store.transaction(data => { data.createdTerminals = [identity.terminalId]; });
  await bridge.start({ timers: false });
  Object.assign(h, { root, backend, store, bridge, terminal, terminals, calls, feishu, errors, config, follow, now, create,
    binding: () => store.binding('oc_test', 'topic'),
    keys: () => calls.filter(c => c.method === 'terminal.keys'), removes: () => calls.filter(c => c.method === 'terminal.rm'),
    advance(ms = 60000) { time += ms; }, async tick() { await bridge.tick(); },
  });
  t.after(async () => { await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  return h;
}

for (const cli of ['claude', 'codex', 'pi']) test(`${cli}: default ten-minute dwell, graceful exit keys, rm, then silent dormancy`, async t => {
  const h = await harness(t, { cli }), before = h.binding();
  await h.tick(); h.advance(599999); await h.tick(); assert.equal(h.keys().length, 0);
  h.advance(1); await h.tick();
  const row = CLI_TABLE.find(row => row.cli === cli);
  assert.equal(h.keys().length, cli === 'codex' ? 2 : 1);
  assert.ok(h.keys().every(call => JSON.stringify(call.params.keys) === JSON.stringify(row.exit.keys)));
  assert.equal(h.removes().length, 1); assert.equal(h.terminals.size, 0);
  assert.equal(h.binding().dormant, true); assert.equal(h.binding().sessionId, before.sessionId);
  assert.equal(h.binding().generation, before.generation);
  assert.equal(h.calls.filter(c => ['terminal.send', 'terminal.kill'].includes(c.method)).length, 0);
  assert.ok(!JSON.stringify(h.feishu.calls).includes('终端已变化'));
  assert.equal(h.store.data.reaps.length, 0);
});

test('idleMinutes one reaps at the configured boundary and survives an idle/done state', async t => {
  const h = await harness(t, { idleMinutes: 1 });
  await h.tick(); h.advance(59999); await h.tick(); assert.equal(h.keys().length, 0);
  h.advance(1); await h.tick(); assert.equal(h.keys().length, 1);
});

for (const mode of ['user', 'other-label', 'placed', 'seen', 'blocked', 'working', 'unknown', 'hc-queue', 'queue', 'needs-check', 'wake', 'frozen', 'foreign-group']) {
  test(`reap skips ${mode} terminals`, async t => {
    const h = await harness(t, { idleMinutes: 1 }); await h.tick();
    if (mode === 'user') h.terminal.labels = {};
    if (mode === 'other-label') h.terminal.labels['ft.woken'] = '0';
    if (mode === 'placed') h.terminal.labels['herdr.tab'] = 'fixture-tab';
    if (mode === 'seen') h.terminal.labels['herdr.seen'] = '0';
    if (['blocked', 'working'].includes(mode)) h.terminal.status.state = mode;
    if (mode === 'unknown') h.terminal.status = null;
    if (mode === 'hc-queue') h.terminal.waiting_for_person = true;
    const patch = { queue: { queuedInputs: [{ type: 'input', text: 'waiting' }], dormant: true },
      'needs-check': { needs_check: true }, wake: { wakePending: true, dormant: true }, frozen: { frozen: true },
      'foreign-group': { chatId: 'oc_other' } }[mode];
    if (patch) await h.store.update('oc_test', 'topic', patch);
    h.advance(600000); await h.tick();
    assert.equal(h.keys().length, 0); assert.equal(h.removes().length, 0); assert.equal(h.terminals.size, 1);
  });
}

test('readiness restarts after work, turn/status changes, ownership changes, input and backend outages', async t => {
  for (const mode of ['working', 'turn', 'status', 'placed', 'input', 'outage']) {
    const h = await harness(t, { idleMinutes: 1 }); await h.tick(); h.advance(59000);
    if (mode === 'working') { h.terminal.status.state = 'working'; await h.tick(); h.terminal.status.state = 'idle'; }
    if (mode === 'turn') h.terminal.turn++;
    if (mode === 'status') h.terminal.status_ms++;
    if (mode === 'placed') { h.terminal.labels['herdr.tab'] = 'fixture'; await h.tick(); delete h.terminal.labels['herdr.tab']; }
    if (mode === 'input') await h.bridge.handle(message('new turn', 'new-input', 'topic'));
    if (mode === 'outage') { h.listDown = true; await h.tick(); h.listDown = false; }
    await h.tick(); h.advance(1000); await h.tick(); assert.equal(h.keys().length, 0, mode);
    h.advance(59000); await h.tick(); assert.equal(h.keys().length, 1, mode);
  }
});

test('visible blocking menu vetoes reap despite a stale ready status', async t => {
  const h = await harness(t, { idleMinutes: 1 }); await h.tick();
  h.terminal.output = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel';
  h.advance(); await h.tick(); assert.equal(h.keys().length, 0);
});

test('only locally owned unbound woken terminals are eligible', async t => {
  const h = await harness(t, { idleMinutes: 1, unbound: true });
  const id = (await h.backend.get('hc:t1')).terminal_id;
  await h.store.transaction(data => { data.createdTerminals = [id]; });
  const other = h.create({ address: 't2' }), remote = h.create({ address: 'host/t3' });
  await h.tick(); h.advance(); await h.tick();
  assert.deepEqual(h.keys().map(c => c.params.terminal), ['t1']);
  assert.equal(other.state, 'live'); assert.equal(remote.state, 'live');
});

test('identity, label or pending input changes during final verification prevent exit', async t => {
  for (const mode of ['identity', 'label', 'pending']) {
    const h = await harness(t, { idleMinutes: 1 }); await h.tick(); h.advance();
    let gets = 0, admission;
    h.onGet = async term => {
      if (++gets !== 3) return; // call Reap directly to isolate the final read after persisted intent
      if (mode === 'identity') term.created_ms++;
      if (mode === 'label') term.labels['herdr.tab'] = 'placed-now';
      if (mode === 'pending') admission = h.bridge.accept(message('race input', 'race', 'topic'));
    };
    await h.bridge.reap.tick(); await admission; await h.bridge.queue;
    assert.equal(h.keys().length, 0, mode); assert.equal(h.removes().length, 0, mode);
    assert.equal(h.bridge.pendingInputs.size, 0);
  }
});

test('ambiguous exit is not repeated, including after restart; confirmed finish can still be removed', async t => {
  const h = await harness(t, { idleMinutes: 1 }); await h.tick(); h.failKeys = true; h.advance(); await h.tick();
  assert.equal(h.keys().length, 1); assert.equal(h.store.data.reaps[0].phase, 'signalling');
  h.advance(); await h.tick(); assert.equal(h.keys().length, 1);
  await h.bridge.stop();
  const store = await new Store(h.store.file).load();
  const bridge = new Bridge({ backend: h.backend, store, feishu: h.feishu, config: h.config, now: h.now,
    sessionFollow: h.follow, adapters: {}, audit: async () => {} });
  t.after(() => bridge.stop()); await bridge.start({ timers: false }); await bridge.tick();
  assert.equal(h.keys().length, 1);
  h.terminal.state = 'finished'; h.advance(); await bridge.tick();
  assert.equal(h.removes().length, 1); assert.equal(store.list()[0].dormant, true);
});

for (const loss of [false, true]) test(`finished removal recovers from ${loss ? 'lost response' : 'temporary failure'} without repeating exit`, async t => {
  const h = await harness(t, { idleMinutes: 1 }); await h.tick();
  h.failRemove = !loss; h.loseRemove = loss; h.advance(); await h.tick();
  assert.equal(h.keys().length, 1); assert.equal(h.store.data.reaps.length, 1);
  h.advance(1000); await h.tick(); assert.equal(h.keys().length, 1);
  assert.equal(h.store.data.reaps.length, 0); assert.equal(h.binding().dormant, true);
});

test('a CLI that ignores its exit keys is never killed or removed, and retries are bounded', async t => {
  const h = await harness(t, { cli: 'codex', idleMinutes: 1 }); h.exitAfter = Infinity;
  await h.tick(); h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.keys().length, 3); assert.equal(h.removes().length, 0);
  assert.equal(h.terminal.state, 'live'); assert.equal(h.binding().dormant, false);
  assert.equal(h.calls.filter(c => c.method === 'terminal.kill').length, 0);
});

test('library rejects invalid idleMinutes even when config loading is bypassed', async t => {
  const h = await harness(t);
  for (const idleMinutes of [0, -1, '1', Infinity, NaN, null]) assert.throws(() => new Bridge({
    backend: h.backend, store: h.store, feishu: h.feishu, config: { ...h.config, idleMinutes },
  }), /idleMinutes/);
});

test('a parent waits for working, blocked and unknown unbound children to complete their own idle dwell', async t => {
  for (const state of ['working', 'blocked', null]) {
    const h = await harness(t, { idleMinutes: 1 });
    const child = h.create({ parent: 't1', labels: {}, status: state && { app: 'pi', state } });
    await h.bridge.reap.tick(); h.advance(600000); await h.bridge.reap.tick();
    assert.equal(h.keys().length, 0, String(state));
    child.status = { app: 'pi', state: 'done' };
    await h.bridge.reap.tick(); h.advance(59999); await h.bridge.reap.tick();
    assert.equal(h.keys().length, 0);
    h.advance(1); await h.bridge.reap.tick();
    assert.deepEqual(h.keys().map(call => call.params.terminal), ['t1']);
    assert.equal(child.state, 'live', 'unowned children are never independently signalled');
  }
});

test('a working parent does not stop an owned idle child from being reaped alone', async t => {
  const h = await harness(t, { idleMinutes: 1 }); h.terminal.status.state = 'working';
  const child = h.create({ parent: 't1', labels: { 'ft.woken': '1', session: 'child' } });
  const identity = h.backend.identity(await h.backend.get(`hc:${child.address}`));
  await h.store.transaction(data => { data.createdTerminals = [identity.terminalId]; });
  await h.bridge.reap.tick(); h.advance(); await h.bridge.reap.tick();
  assert.deepEqual(h.keys().map(call => call.params.terminal), ['t2']);
  assert.equal(h.terminal.state, 'live');
});

test('grandchildren, late children and a changed child identity restart the dependency dwell', async t => {
  for (const change of ['grandchild', 'late', 'identity']) {
    const h = await harness(t, { idleMinutes: 1 });
    const child = h.create({ parent: 't1', labels: {} });
    const grand = change === 'grandchild' && h.create({ parent: child.address, labels: {}, status: { app: 'pi', state: 'working' } });
    await h.bridge.reap.tick(); h.advance(59000);
    if (change === 'late') h.create({ parent: 't1', labels: {} });
    if (change === 'identity') child.created_ms++;
    if (grand) grand.status.state = 'done';
    await h.bridge.reap.tick(); h.advance(1000); await h.bridge.reap.tick();
    assert.equal(h.keys().length, 0, change);
    h.advance(59000); await h.bridge.reap.tick(); assert.equal(h.keys().length, 1, change);
  }
});

test('child placement, pending input and visible approval veto a parent exit', async t => {
  for (const veto of ['placed', 'pending', 'approval', 'waiting']) {
    const h = await harness(t, { idleMinutes: 1 });
    const child = h.create({ parent: 't1', labels: {} });
    const identity = h.backend.identity(await h.backend.get(`hc:${child.address}`));
    await h.store.bind({ chatId: 'oc_test', topicId: 'child-topic', paneId: `hc:${child.address}`, identity });
    await h.bridge.reap.tick(); h.advance();
    if (veto === 'placed') child.labels['herdr.tab'] = 'fixture';
    if (veto === 'pending') h.bridge.pendingInputs.set('child-topic', 1);
    if (veto === 'approval') child.output = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel';
    if (veto === 'waiting') child.waiting_for_person = true;
    await h.bridge.reap.tick(); assert.equal(h.keys().length, 0, veto);
  }
});

test('a child changing or appearing during the final parent check prevents exit', async t => {
  for (const race of ['working', 'new', 'pending', 'parent-working']) {
    const h = await harness(t, { idleMinutes: 1 });
    const child = h.create({ parent: 't1', labels: {} });
    const identity = h.backend.identity(await h.backend.get(`hc:${child.address}`));
    await h.store.bind({ chatId: 'oc_test', topicId: 'child-topic', paneId: `hc:${child.address}`, identity });
    await h.bridge.reap.tick(); h.advance();
    const save = h.bridge.reap.save.bind(h.bridge.reap);
    h.bridge.reap.save = async record => {
      await save(record);
      if (race === 'working') child.status.state = 'working';
      if (race === 'new') h.create({ parent: 't1', labels: {} });
      if (race === 'pending') h.bridge.pendingInputs.set('child-topic', 1);
      if (race === 'parent-working') h.onRead = term => { if (term.address === child.address) h.terminal.status.state = 'working'; };
    };
    await h.bridge.reap.tick(); assert.equal(h.keys().length, 0, race);
    assert.equal(h.store.data.reaps.length, 0);
  }
});

test('finished children do not hold a parent open and a descendant outage cancels exit', async t => {
  for (const outage of [false, true]) {
    const h = await harness(t, { idleMinutes: 1 });
    const child = h.create({ parent: 't1', labels: {}, state: outage ? 'live' : 'finished' });
    await h.bridge.reap.tick(); h.advance();
    h.onGet = term => { if (outage && term.address === child.address) throw Object.assign(new Error('offline'), { code: 'unavailable' }); };
    await h.bridge.reap.tick(); assert.equal(h.keys().length, outage ? 0 : 1);
    if (outage) {
      h.onGet = () => {};
      await h.bridge.reap.tick(); await h.bridge.reap.tick();
      h.advance(59999); await h.bridge.reap.tick(); assert.equal(h.keys().length, 0);
      h.advance(1); await h.bridge.reap.tick(); assert.equal(h.keys().length, 1);
    }
  }
});

test('a saved child resumed before its parent still holds the parent open without a native parent address', async t => {
  const h = await harness(t, { idleMinutes: 1 });
  const child = h.create({ labels: {}, status: { app: 'pi', state: 'working' } });
  const identity = h.backend.identity(await h.backend.get(`hc:${child.address}`));
  await h.store.bind({ chatId: 'oc_test', topicId: 'child-topic', paneId: `hc:${child.address}`, identity,
    tree: { parentTopicId: 'topic', parentTerminalId: h.binding().identity.terminalId } });
  await h.bridge.reap.tick(); h.advance(600000); await h.bridge.reap.tick();
  assert.equal(h.keys().length, 0);
  child.status.state = 'done'; await h.bridge.reap.tick(); h.advance(59999); await h.bridge.reap.tick();
  assert.equal(h.keys().length, 0); h.advance(1); await h.bridge.reap.tick();
  assert.deepEqual(h.keys().map(call => call.params.terminal), ['t1']);
});

for (const cli of ['claude', 'codex', 'pi']) test(`${cli}: ft-created error terminal settles, reaps and resumes on input; working stays live`, async t => {
  const h = await harness(t, { cli, labels: {} });
  await h.store.transaction(data => { data.createdTerminals = [h.binding().identity.terminalId]; });
  h.terminal.status.state = 'error';
  const working = h.create({ cwd: 'other-project', foreground: { pid: 9999, name: 'cmd.exe', cwd: 'other-project' }, labels: {}, status: { app: cli, state: 'working' } });
  const workingIdentity = (await h.backend.get(`hc:${working.address}`)).terminal_id;
  await h.store.transaction(data => { data.createdTerminals.push(workingIdentity); });
  await h.tick(); h.advance(599999); await h.tick(); assert.equal(h.removes().length, 0);
  h.advance(1); await h.tick();
  assert.equal(h.binding().dormant, true); assert.equal(h.removes().length, 1); assert.equal(working.state, 'live');
  await h.bridge.handle(message('resume input', 'resume-error', 'topic'));
  assert.equal(h.binding().dormant, false);
  assert.ok(h.calls.some(c => c.method === 'terminal.run'));
  assert.ok(h.calls.some(c => c.method === 'terminal.send' && c.params.text === 'resume input'));
});
