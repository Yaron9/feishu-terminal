import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyHarness, message, mockFeishu } from './helpers.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { screenControls } from '../src/render.js';

test('settled turn picker selection immediately patches and shows screen-only result', async t => {
  const records = [];
  const adapter = { locate: async () => 'fake.jsonl', read: async (_path, cursor) => ({ cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset) }) };
  const h = await legacyHarness(t, { adapters: { codex: adapter } });
  const pane = h.fake.create(); Object.assign(pane, { agent: 'codex', agent_status: 'working', visible: 'Ready' });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const binding = () => h.bridge.store.forPane('w1:p1');
  await h.bridge.handle(message('hello', 'prompt', binding().topicId));
  records.push({ role: 'user', text: 'hello' }, { role: 'assistant', text: 'Finished' });
  pane.agent_status = 'idle'; h.advance(4000); await h.bridge.tick();
  pane.visible = ' Resume a previous session\n Type to search\n  › 9s ago      current\n    1h ago      other\n enter resume   esc exit   ↑↓ change option'; h.advance(3000); h.bridge.state(binding()).dirty = true; await h.bridge.tick();
  const b = binding(), id = b.cardId, nonce = b.menuNonce;
  assert.equal(b.menuCardId, id);
  const original = h.bridge.backend.sendKeys.bind(h.bridge.backend);
  h.bridge.backend.sendKeys = async (...args) => {
    assert.match(JSON.stringify(h.feishu.calls.filter(c => c.type === 'patch').at(-1)), /已选择：9s ago      current/);
    pane.visible = 'Already viewing current session'; return original(...args);
  };
  await h.bridge.handle({ kind:'button', eventId:'choice', chatId:b.chatId, topicId:b.topicId, openId:'ou_test', messageId:id, nonce, key:'menu:select:0' });
  const early = h.feishu.calls.length;
  await h.bridge.handle({ kind:'button', eventId:'early-stale', chatId:b.chatId, topicId:b.topicId, openId:'ou_test', messageId:id, nonce, key:'menu:select:0' });
  assert.ok(h.feishu.calls.slice(early).some(c => c.type === 'patch'));
  assert.ok(!h.feishu.calls.slice(early).some(c => c.type === 'reply'));
  h.advance(4000); h.bridge.state(binding()).dirty = true; await h.bridge.tick();
  const result = JSON.stringify(h.feishu.calls.filter(c => c.type === 'patch').at(-1));
  assert.match(result, /Already viewing current session/); assert.match(result, /已选择：9s ago      current/); assert.doesNotMatch(result, /menu:select/);
  const count = h.feishu.calls.length;
  await h.bridge.handle({ kind:'button', eventId:'stale', chatId:b.chatId, topicId:b.topicId, openId:'ou_test', messageId:id, nonce, key:'menu:select:0' });
  assert.ok(h.feishu.calls.slice(count).some(c => c.type === 'patch')); assert.ok(!h.feishu.calls.slice(count).some(c => c.type === 'reply'));
});



test('model errors are not confirmations and yes/no controls require a live prompt', () => {
  const backend = new HcBackend({});
  const pane = { reported: true, status: { state: 'error', app: 'pi' } };
  const screen = 'Error: model request failed\n? /resume';
  assert.equal(backend.status(pane, screen), 'error');
  assert.ok(!screenControls(screen).some(([, key]) => key === 'y' || key === 'n'));
  assert.deepEqual(screenControls('Continue? (y/n)').filter(([, key]) => ['y', 'n'].includes(key)).map(([, key]) => key), ['y', 'n']);
  assert.ok(!screenControls('Continue? (y/n)\n' + 'old\n'.repeat(11) + '? ').some(([, key]) => key === 'y'));
});

test('failed key send shows failure and restores picker choices', async t => {
  const h = await legacyHarness(t, { adapters: {} }), pane = h.fake.create();
  Object.assign(pane, { agent:'codex', agent_status:'idle', visible: await readFile(new URL('./fixtures/w7r/codex-model.txt', import.meta.url), 'utf8') });
  await h.bridge.handle(message('/t open w1:p1', 'open')); h.advance(2000); await h.bridge.tick();
  const b = h.bridge.store.forPane('w1:p1'); assert.ok(b.cardMenu.items.length);
  h.bridge.backend.sendKeys = async () => { throw Object.assign(new Error('failed'), { code:'unavailable' }); };
  await h.bridge.handle({kind:'button', eventId:'fail', chatId:b.chatId, topicId:b.topicId, openId:'ou_test', messageId:b.cardId, nonce:b.menuNonce, key:'1'});
  const patch = JSON.stringify(h.feishu.calls.filter(c => c.type === 'patch').at(-1));
  assert.match(patch, /\u53d1\u9001\u5931\u8d25/); assert.match(patch, /GPT-6/);
});

test('paging retains picker buttons', async t => {
  const h = await legacyHarness(t, { adapters: {} }), pane = h.fake.create();
  Object.assign(pane, { agent:'pi', agent_status:'idle', visible: 'Select model\n> Model 0\n' + Array.from({ length: 12 }, (_, i) => `  Model ${i + 1}`).join('\n') + '\nEsc to cancel' });
  await h.bridge.handle(message('/t open w1:p1', 'open')); h.advance(2000); await h.bridge.tick();
  let b = h.bridge.store.forPane('w1:p1'); assert.ok(b.cardMenu.items.length > b.menuPageSize);
  await h.bridge.handle({kind:'button', eventId:'page', chatId:b.chatId, topicId:b.topicId, openId:'ou_test', messageId:b.cardId, nonce:b.menuNonce, key:'menu:more'});
  h.advance(2000); h.bridge.state(b).dirty = true; await h.bridge.tick(); b = h.bridge.store.forPane('w1:p1');
  assert.equal(b.menuPage, 1); assert.match(JSON.stringify(h.feishu.calls.filter(c => c.type === 'patch').at(-1)), /menu:select/);
});

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
      if (method === 'terminal.run') return create({ labels: params.labels, cwd: params.cwd });
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
    reapOptions: { waitMs: 200, sleep: async ms => { time += ms; } } });
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



test('created idle terminal reaps after ten minutes while attached and open picker remain live', async t => {
  const created = await harness(t, { labels: {} });
  await created.store.transaction(data => { data.createdTerminals = [created.binding().identity.terminalId]; });
  await created.tick(); created.advance(599999); await created.tick(); assert.equal(created.keys().length, 0);
  created.advance(1); await created.tick(); assert.equal(created.binding().dormant, true); assert.equal(created.removes().length, 1);
  await created.bridge.handle(message('resume work', 'resume', 'topic'));
  assert.equal(created.binding().dormant, false);
  assert.ok(created.calls.some(c => c.method === 'terminal.run' && c.params.line.includes('same')));
  assert.ok(created.calls.some(c => c.method === 'terminal.send' && c.params.text === 'resume work'));
  const attached = await harness(t, { labels: {} }); await attached.tick(); attached.advance(600000); await attached.tick(); assert.equal(attached.keys().length, 0);
  const picker = await harness(t, { labels: {} }); await picker.store.transaction(data => { data.createdTerminals = [picker.binding().identity.terminalId]; });
  await picker.tick(); picker.terminal.output = 'Do you want to proceed?\n> 1. Yes\n  2. No\nEsc to cancel'; picker.advance(600000); await picker.tick(); assert.equal(picker.keys().length, 0);
});

