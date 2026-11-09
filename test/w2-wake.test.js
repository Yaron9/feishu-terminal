import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { ClaudeTranscript, projectDirectory } from '../src/transcripts/claude.js';
import { mockFeishu, message } from './helpers.js';

async function harness(t, { cli = 'pi', known = true, ready = 'idle' } = {}) {
  const home = await mkdtemp(new URL('../.test-w2-', import.meta.url)), cwd = 'C:\\fixture\\project';
  let time = Date.now(), sequence = 0, callbackSequence = 0;
  const now = () => time, terminals = new Map(), calls = [], errors = [];
  const h = { home, cwd, calls, terminals, onRun: () => {}, onSleep: () => {}, loseRun: false, listDown: false };
  const create = (props = {}) => {
    const address = `t${++sequence}`, pid = 1000 + sequence;
    const terminal = { address, pid, created_ms: time + sequence, state: 'live', cwd, labels: {},
      foreground: { pid, name: 'cmd.exe', argv: ['cmd.exe', '/c', `${cli}.CMD`], cwd },
      reported: true, status: { app: cli === 'claude' ? 'claude-code' : cli, state: ready },
      output: 'Update available. Press Enter to continue.', ...props };
    terminals.set(address, terminal); return terminal;
  };
  const client = {
    async request(method, params, hello) {
      calls.push({ method, params }); hello?.({ core: { id: 'fixture-core' } });
      const terminal = terminals.get(params.terminal);
      if (method === 'terminal.list') {
        if (h.listDown) throw Object.assign(new Error('offline'), { code: 'unavailable' });
        return { terminals: [...terminals.values()] };
      }
      if (method === 'terminal.run') {
        const term = create({ labels: params.labels, cwd: params.cwd, parent: params.parent, argv: ['cmd.exe', '/c', params.line], status: null });
        await h.onRun(term);
        if (h.loseRun) { h.loseRun = false; throw Object.assign(new Error('lost'), { code: 'connection_closed' }); }
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
  if (known) {
    const dir = join(home, '.pi', 'agent', 'sessions', 'fixture'); await mkdir(dir, { recursive: true });
    // A Windows cwd and cmd.exe foreground must still identify pi via status.app.
    await writeFile(join(dir, 'fixture_same.jsonl'), JSON.stringify({ type: 'session', id: 'same', cwd }) + '\n');
  }
  const store = await new Store(join(home, 'state.json')).load(), feishu = mockFeishu(now);
  const backend = new Backends([new HcBackend(client)]);
  const follow = new SessionFollow({ home, procRoot: join(home, 'absent-proc'), now, sleep: async ms => { time += ms; } });
  const config = { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: cwd };
  const bridge = new Bridge({ backend, feishu, store, config, now, adapters: {}, sessionFollow: follow,
    audit: async () => {}, onError: error => errors.push(error),
    wakeOptions: { timeoutMs: 1000, sleep: async ms => { time += ms; await h.onSleep(); } } });
  const old = create({ created_ms: 0 });
  if (cli !== 'pi') old.labels.session = known ? 'same' : undefined;
  await bridge.handle(message('/t open hc:t1', 'open'));
  const binding = () => store.list()[0];
  const dormant = async () => { old.state = 'finished'; time += 2000; await bridge.tick(); };
  Object.assign(h, { store, feishu, backend, follow, bridge, old, binding, dormant, create, errors,
    advance(ms = 2000) { time += ms; },
    sends: () => calls.filter(c => c.method === 'terminal.send'), runs: () => calls.filter(c => c.method === 'terminal.run'),
    send: (text = 'queued text', id = 'input') => bridge.handle(message(text, id, binding().topicId)),
    ready(term, state = ready) { term.reported = true; term.status = { app: cli === 'claude' ? 'claude-code' : cli, state }; },
    click: (key = 'refresh', overrides = {}) => bridge.handle({ kind: 'button', eventId: `click-${++callbackSequence}`,
      chatId: binding().chatId, topicId: binding().topicId, openId: 'ou_test', messageId: binding().cardId,
      nonce: binding().nonce, key, ...overrides }),
  });
  t.after(async () => { await bridge.stop(); await rm(home, { recursive: true, force: true }); });
  return h;
}

test('finished and missing terminals become dormant silently and retain probed CLI/cwd/session', async t => {
  for (const missing of [false, true]) {
    const h = await harness(t), before = h.binding(), count = h.feishu.calls.length;
    assert.equal(before.cli, 'pi'); assert.equal(before.cwd, h.cwd); assert.equal(before.sessionId, 'same');
    if (missing) h.terminals.delete('t1'); else h.old.state = 'finished';
    h.advance(); await h.bridge.tick();
    assert.equal(h.binding().dormant, true); assert.equal(h.binding().frozen, false);
    assert.equal(h.binding().sessionId, 'same'); assert.equal(h.feishu.calls.length, count);
    assert.equal(h.binding().generation, before.generation);
  }
});

for (const phase of ['refresh', 'publishCard']) {
  test(`terminal finishing during ${phase} becomes dormant without failure logs`, async t => {
    const h = await harness(t), original = h.bridge[phase].bind(h.bridge), causes = [];
    h.bridge[phase] = async (...args) => {
      h.old.state = 'finished';
      try { return await original(...args); }
      catch (error) { causes.push(error.code); throw error; }
    };
    h.bridge.state(h.binding()).cardPending = true;
    const calls = h.feishu.calls.length;
    h.advance(); await h.bridge.tick();
    assert.deepEqual(causes, ['binding_dormant']);
    assert.equal(h.binding().dormant, true);
    assert.equal(h.binding().frozen, false);
    assert.equal(h.feishu.calls.length, calls);
    assert.deepEqual(h.errors, []);
  });
}

test('queue and refresh failures retain short causes without upstream messages or payloads', async t => {
  const h = await harness(t);
  const failure = Object.assign(new Error('secret terminal text token=fixture-secret'), { code: 'fixture_error' });
  await assert.rejects(h.bridge.enqueue(() => { throw failure; }), failure);
  assert.deepEqual(h.errors.splice(0), ['bridge_operation_failed fixture_error']);
  for (const [method, prefix] of [['refresh', 'output_refresh_failed'], ['flush', 'output_flush_failed'], ['refreshCard', 'card_refresh_failed']]) {
    const original = h.bridge[method];
    h.bridge[method] = async () => { throw failure; };
    h.advance(); await h.bridge.tick();
    h.bridge[method] = original;
    assert.deepEqual(h.errors.splice(0), [`${prefix} fixture_error`]);
  }
  // Uncoded errors still identify the error class, without echoing data.
  await assert.rejects(h.bridge.enqueue(() => { throw new TypeError('secret terminal text'); }), TypeError);
  assert.deepEqual(h.errors.splice(0), ['bridge_operation_failed TypeError']);
  const unsafe = Object.assign(new Error('secret'), { code: 'bad\nsecret=fixture-secret' });
  await assert.rejects(h.bridge.enqueue(() => { throw unsafe; }), unsafe);
  assert.deepEqual(h.errors, ['bridge_operation_failed Error']);
});

for (const [cli, ready, command] of [['pi', 'done', 'pi --session same'], ['codex', 'idle', 'codex resume same --no-daemon -c check_for_update_on_startup=false'], ['claude', 'idle', 'claude --resume same']]) {
  test(`${cli}: wake waits for ${ready}, changes generation, and submits queued text through input`, async t => {
    const h = await harness(t, { cli, ready }), before = h.binding(); await h.dormant();
    let sleeps = 0;
    h.onSleep = () => { assert.equal(h.sends().length, 0); if (++sleeps === 2) h.ready(h.terminals.get('t2')); };
    await h.send('  phone\ntext  ');
    assert.equal(sleeps, 2); assert.equal(h.runs().length, 1);
    assert.deepEqual(h.runs()[0].params.labels, { 'ft.woken': '1', session: 'same', source: 'feishu-terminal' });
    assert.equal(h.runs()[0].params.line, command); assert.equal(h.runs()[0].params.cwd, h.cwd);
    assert.equal(h.binding().paneId, 'hc:t2'); assert.notEqual(h.binding().generation, before.generation);
    assert.notDeepEqual(h.binding().identity, before.identity); assert.equal(h.binding().dormant, false);
    assert.deepEqual(h.binding().queuedInputs, []); assert.equal(h.sends()[0].params.text, '  phone\ntext  ');
    assert.equal(h.sends()[0].params.terminal, 't2'); assert.equal(h.binding().needs_check, false);
    assert.equal(h.feishu.calls.filter(c => c.content === '正在唤醒…').length, 1);
  });
}

test('timeout retains queue and old generation, posts screen with keys, then ready tick delivers once', async t => {
  const h = await harness(t), before = h.binding(); await h.dormant(); await h.send();
  assert.equal(h.binding().generation, before.generation); assert.equal(h.binding().dormant, true);
  assert.equal(h.binding().queuedInputs.length, 1); assert.equal(h.sends().length, 0);
  const card = h.feishu.calls.find(c => c.id === h.binding().wakeCardId);
  assert.match(JSON.stringify(card.content), /Update available/); assert.match(JSON.stringify(card.content), /ctrl\+c/);
  assert.match(JSON.stringify(card.content), /enter/);
  // Invalid own-card credentials never send keys or launch another process.
  await h.click('enter', { nonce: 'forged' }); assert.equal(h.calls.filter(c => c.method === 'terminal.keys').length, 0);
  const callback = { nonce: h.binding().nonce, messageId: h.binding().cardId };
  await h.click('enter');
  assert.deepEqual(h.calls.filter(c => c.method === 'terminal.keys').map(c => c.params.keys), [['enter']]);
  await h.click('enter', { ...callback, eventId: 'replayed' });
  assert.equal(h.calls.filter(c => c.method === 'terminal.keys').length, 1);
  h.ready(h.terminals.get('t2'), 'done'); h.advance(); await h.bridge.tick(); h.advance(); await h.bridge.tick();
  assert.equal(h.sends().length, 1); assert.equal(h.binding().queuedInputs.length, 0); assert.equal(h.runs().length, 1);
});

test('parallel messages and a second dormant binding for one session cannot double wake', async t => {
  const h = await harness(t); await h.dormant(); h.onRun = term => h.ready(term);
  await Promise.all([h.send('first', 'one'), h.send('second', 'two')]);
  assert.equal(h.runs().length, 1); assert.deepEqual(h.sends().map(c => c.params.text), ['first', 'second']);
  await h.store.bind({ chatId: 'oc_test', topicId: 'other-topic', paneId: 'hc:t99', dormant: true,
    cli: 'pi', cwd: h.cwd, sessionId: 'same', identity: { terminalId: 'old' } });
  await h.bridge.handle(message('other', 'other-event', 'other-topic'));
  assert.equal(h.runs().length, 1); assert.equal(h.store.binding('oc_test', 'other-topic').queuedInputs.length, 1);
});

test('unknown session id is reported once in Chinese, never guessed, and input stays durable', async t => {
  const h = await harness(t, { known: false }); await h.dormant();
  await h.send('one', 'one'); await h.send('two', 'two');
  assert.equal(h.runs().length, 0); assert.equal(h.sends().length, 0);
  assert.equal(h.feishu.calls.filter(c => String(c.content).includes('没有可靠的会话编号')).length, 1);
  const restored = await new Store(h.store.file).load(); assert.equal(restored.list()[0].queuedInputs.length, 2);
  assert.equal(restored.list()[0].unknownSessionNotified, true);
});

test('lost run response is recovered by session labels even before agent status exists', async t => {
  const h = await harness(t); await h.dormant(); h.loseRun = true; await h.send();
  assert.equal(h.binding().wakeAttempt.phase, 'launching'); assert.equal(h.runs().length, 1);
  h.advance(); await h.bridge.tick(); assert.equal(h.runs().length, 1); assert.equal(h.binding().wakeTarget.paneId, 'hc:t2');
  h.ready(h.terminals.get('t2')); h.advance(); await h.bridge.tick();
  assert.equal(h.runs().length, 1); assert.equal(h.sends().length, 1);
});

test('hc list outage and external process evidence cannot authorize a competing resume', async t => {
  for (const outage of [true, false]) {
    const h = await harness(t); await h.dormant();
    if (outage) h.listDown = true;
    else h.follow.candidates = async () => [{ pid: 100, start: 1, sessionId: 'same', terminalId: null }];
    await h.send(); assert.equal(h.runs().length, 0); assert.equal(h.binding().queuedInputs.length, 1);
    assert.equal(h.sends().length, 0);
  }
});

test('a valid own-card action wakes a dormant topic; foreign and unauthorized cards cannot', async t => {
  const h = await harness(t); await h.bridge.refresh(h.binding(), true); await h.dormant();
  h.onRun = term => h.ready(term);
  await h.click('refresh', { messageId: 'foreign-card' });
  await h.click('refresh', { eventId: 'bad-user', openId: 'ou_other' });
  assert.equal(h.runs().length, 0);
  await h.click('refresh', { eventId: 'valid-card' }); assert.equal(h.runs().length, 1);
  assert.equal(h.binding().dormant, false); assert.equal(h.sends().length, 0);
});

test('portable follow uses hc identity/process facts without /proc and terminates only verified older hc terminal', async t => {
  const h = await harness(t), before = h.binding();
  h.old.labels.session = 'same';
  h.advance(); const newer = h.create({ labels: { session: 'same' } });
  await h.bridge.scanSessions();
  assert.equal(h.binding().paneId, `hc:${newer.address}`); assert.notEqual(h.binding().generation, before.generation);
  assert.equal(h.old.state, 'finished'); assert.equal(newer.state, 'live');
  assert.deepEqual(h.calls.filter(c => c.method === 'terminal.kill').map(c => c.params.terminal), ['t1']);
  assert.equal(h.binding().sessionHandoff.done, true);
  assert.equal((await h.follow.candidates('same')).length, 1);
});

test('queued input survives a failure before the send starts', async t => {
  const h = await harness(t); await h.dormant(); h.onRun = term => h.ready(term);
  const original = h.bridge.initializeTranscript.bind(h.bridge);
  h.bridge.initializeTranscript = async () => { throw Object.assign(new Error('read failed'), { code: 'backend_unavailable' }); };
  await h.send('retained');
  assert.equal(h.sends().length, 0);
  assert.equal(h.binding().queuedInputs[0]?.text, 'retained');
  assert.notEqual(h.binding().needs_check, true);
  h.bridge.initializeTranscript = original;
  h.advance(); await h.bridge.tick();
  assert.deepEqual(h.sends().map(c => c.params.text), ['retained']);
  assert.equal(h.binding().queuedInputs.length, 0);
});

test('queued input is not replayed after an ambiguous send', async t => {
  const h = await harness(t); await h.dormant(); h.onRun = term => h.ready(term);
  const send = h.backend.sendText.bind(h.backend);
  h.backend.sendText = async (...args) => { await send(...args); throw Object.assign(new Error('lost'), { code: 'connection_closed' }); };
  await h.send(); assert.equal(h.sends().length, 1); assert.equal(h.binding().needs_check, true);
  h.advance(); await h.bridge.tick(); assert.equal(h.sends().length, 1);
  assert.equal(JSON.parse(await readFile(h.store.file, 'utf8')).bindings[0].queuedInputs.length, 0);
});

test('a message detects closure immediately without a preceding tick', async t => {
  const h = await harness(t); h.old.state = 'finished'; h.onRun = term => h.ready(term);
  await h.send(); assert.equal(h.runs().length, 1); assert.equal(h.sends().length, 1);
  assert.ok(!JSON.stringify(h.feishu.calls).includes('终端已变化'));
});

test('concurrent dormant topics with one session share the wake lock', async t => {
  const h = await harness(t); await h.dormant();
  await h.store.bind({ chatId: 'oc_test', topicId: 'second-topic', paneId: 'hc:t99', dormant: true,
    cli: 'pi', cwd: h.cwd, sessionId: 'same', identity: { terminalId: 'old' } });
  h.onRun = term => h.ready(term);
  await Promise.all([h.send('first', 'first'), h.bridge.handle(message('second', 'second', 'second-topic'))]);
  assert.equal(h.runs().length, 1); assert.equal(h.sends().length, 1);
  assert.equal(h.store.binding('oc_test', 'second-topic').queuedInputs.length, 1);
});

test('reuse an existing session found in a Windows resume shim without launching another process', async t => {
  const h = await harness(t); await h.dormant();
  const live = h.create({ foreground: { pid: 1002, name: 'cmd.exe', cwd: h.cwd,
    argv: ['cmd.exe', '/c', '"C:\\npm\\pi.CMD" --session same'] } });
  await h.send(); assert.equal(h.runs().length, 0); assert.equal(h.sends().length, 1);
  assert.equal(h.binding().paneId, `hc:${live.address}`);
});

test('an unidentified live session in the same directory blocks a competing resume', async t => {
  const h = await harness(t); await h.dormant();
  h.create(); // session file predates this process; no trustworthy ID is available
  await h.send(); assert.equal(h.runs().length, 0); assert.equal(h.sends().length, 0);
  assert.equal(h.binding().queuedInputs.length, 1);
});

test('timeout queue and target survive restart, then deliver without another run', async t => {
  const h = await harness(t); await h.dormant(); await h.send();
  const restored = await new Store(h.store.file).load();
  assert.equal(restored.list()[0].queuedInputs.length, 1);
  await h.bridge.stop(); h.ready(h.terminals.get('t2'), 'done');
  const bridge = new Bridge({ backend: h.backend, feishu: h.feishu, store: restored,
    config: h.bridge.config, now: h.bridge.now, adapters: {}, sessionFollow: h.follow, audit: async () => {} });
  t.after(() => bridge.stop()); await bridge.start({ timers: false });
  assert.equal(h.runs().length, 1); assert.equal(h.sends().length, 1);
  assert.deepEqual(restored.list()[0].queuedInputs, []); assert.equal(restored.list()[0].dormant, false);
});

test('a replaced wake target freezes without delivering queued input or sending control keys', async t => {
  const h = await harness(t); await h.dormant(); await h.send();
  h.terminals.get('t2').created_ms++;
  await h.click('enter'); assert.equal(h.binding().frozen, true);
  assert.equal(h.sends().length, 0); assert.equal(h.calls.filter(c => c.method === 'terminal.keys').length, 0);
  assert.equal(h.binding().queuedInputs.length, 1);
});

test('a dormant own-card can still wake its session after ten minutes', async t => {
  const h = await harness(t); await h.bridge.refresh(h.binding(), true); await h.dormant(); h.advance(600000);
  h.onRun = terminal => h.ready(terminal);
  await h.click(); assert.equal(h.runs().length, 1);
  assert.ok(!h.feishu.calls.some(c => c.content === '卡片已过期，请重新 /t screen'));
});

test('a timeout key is skipped if the CLI became ready; queued text still arrives once', async t => {
  const h = await harness(t); await h.dormant(); await h.send(); h.ready(h.terminals.get('t2'));
  await h.click('enter'); assert.equal(h.calls.filter(c => c.method === 'terminal.keys').length, 0);
  assert.equal(h.sends().length, 1);
});

test('Claude transcript lookup uses unique Windows cwd metadata when /proc is absent', async t => {
  const h = await harness(t, { cli: 'claude' });
  const sessions = join(h.home, '.claude', 'sessions'); await mkdir(sessions, { recursive: true });
  await mkdir(join(sessions, 'unreadable.key'));
  const project = join(h.home, '.claude', 'projects', projectDirectory(h.cwd)); await mkdir(project, { recursive: true });
  const file = join(project, 'same.jsonl'); await writeFile(file, '');
  await writeFile(join(sessions, '123.json'), JSON.stringify({ pid: 123, sessionId: 'same', cwd: h.cwd, ignored: 'secret' }));
  const adapter = new ClaudeTranscript({ home: h.home, procRoot: join(h.home, 'absent') });
  const terminal = await h.backend.get('hc:t1');
  assert.equal(await adapter.locate(terminal), file);
  await writeFile(join(sessions, '456.json'), JSON.stringify({ pid: 456, sessionId: 'other', cwd: h.cwd }));
  assert.equal(await adapter.locate(terminal), null);
});

test('parent wake leaves children dormant through restart; only child-topic input resumes and reattaches that child', async t => {
  const h = await harness(t); h.bridge.config.sessionFollow = 'warn';
  const child = h.create({ parent: 't1', name: 'w6-child', labels: { session: 'child-fixture' } });
  h.advance(); await h.bridge.tick();
  const childBinding = h.store.forPane(`hc:${child.address}`), parentTopic = h.binding().topicId;
  assert.ok(childBinding?.tree);
  h.old.state = child.state = 'finished'; h.advance(); await h.bridge.tick();
  assert.equal(h.store.binding('oc_test', childBinding.topicId).dormant, true);
  h.onRun = terminal => h.ready(terminal, 'done');
  await h.send('parent-only', 'wake-parent');
  const parent = h.store.binding('oc_test', parentTopic);
  assert.equal(h.runs().length, 1); assert.equal(parent.dormant, false);
  assert.equal(h.store.binding('oc_test', childBinding.topicId).dormant, true);
  assert.equal(h.store.binding('oc_test', childBinding.topicId).tree.parentTerminalId, parent.identity.terminalId);
  await h.bridge.stop();
  const restored = await new Store(h.store.file).load();
  const bridge = new Bridge({ backend: h.backend, feishu: h.feishu, store: restored, config: h.bridge.config,
    now: h.bridge.now, adapters: {}, sessionFollow: h.follow, audit: async () => {} });
  t.after(() => bridge.stop()); await bridge.start({ timers: false }); h.advance(); await bridge.tick();
  assert.equal(h.runs().length, 1, 'startup and polling must not eagerly launch children');
  await bridge.handle(message('child-only', 'wake-child', childBinding.topicId));
  assert.equal(h.runs().length, 2);
  assert.equal(h.runs()[1].params.line, 'pi --session child-fixture');
  assert.equal(h.runs()[1].params.parent, parent.paneId.slice(3));
  assert.equal(h.runs()[1].params.no_parent, undefined);
  const resumed = restored.binding('oc_test', childBinding.topicId);
  assert.equal(resumed.dormant, false); assert.equal(resumed.sessionId, 'child-fixture');
  assert.equal(resumed.tree.parentTopicId, parentTopic); assert.notEqual(resumed.tree.status, 'finished');
  assert.ok(restored.data.treeSeen.includes(resumed.identity.terminalId));
  assert.deepEqual(h.sends().map(call => call.params.text), ['parent-only', 'child-only']);
});

test('child-topic input can resume a child alone while its parent stays dormant', async t => {
  const h = await harness(t); h.bridge.config.sessionFollow = 'warn';
  const child = h.create({ parent: 't1', name: 'w6-child', labels: { session: 'child-fixture' } });
  h.advance(); await h.bridge.tick(); const binding = h.store.forPane(`hc:${child.address}`);
  h.old.state = child.state = 'finished'; h.advance(); await h.bridge.tick();
  h.onRun = terminal => h.ready(terminal, 'done');
  await h.bridge.handle(message('child-only', 'wake-child-alone', binding.topicId));
  assert.equal(h.runs().length, 1); assert.equal(h.runs()[0].params.no_parent, true);
  assert.equal(h.runs()[0].params.line, 'pi --session child-fixture');
  assert.equal(h.binding().dormant, true); assert.equal(h.store.binding('oc_test', binding.topicId).dormant, false);
});
