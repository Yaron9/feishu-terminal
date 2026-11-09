import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { selftest } from '../src/selftest.js';
import { HerdrClient } from '../src/herdr-client.js';
import { FeishuError } from '../src/feishu.js';
import { fakeHerdr } from './helpers.js';

async function run(t, { badReadback = false, missedInterrupt = false, wsFailed = false,
  historyDenied, perIdDenied = false, scroll, schema2Fallback = false, invalidDelivery } = {}) {
  const dir = await mkdtemp(new URL('../.test-selftest-', import.meta.url));
  const fake = await fakeHerdr();
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const client = new HerdrClient({ endpoint: fake.endpoint, timeoutMs: 1000 });
  const untouched = fake.create(); // A desktop pane which must survive every success/failure path.
  const pending = new Map(), sleeping = new Set();
  const herdr = { subscribe: (...args) => client.subscribe(...args), close: () => client.close(),
    async request(method, params = {}) {
      const result = await client.request(method, params);
      if (scroll && result.root_pane) fake.panes.get(result.root_pane.pane_id).scroll = { ...scroll };
      if (method === 'pane.send_text') pending.set(params.pane_id, params.text);
      if (method === 'pane.send_keys') {
        if (params.keys.includes('ctrl+c') && !missedInterrupt) sleeping.delete(params.pane_id);
        if (params.keys.includes('enter') && !sleeping.has(params.pane_id)) {
          const text = pending.get(params.pane_id) || '';
          if (text.includes('sleep 30')) sleeping.add(params.pane_id);
          else {
            const value = /echo (selftest-[a-z0-9-]+)/.exec(text)?.[1];
            if (value) fake.output(params.pane_id, fake.panes.get(params.pane_id).text + '\n' + value + '\n$ ');
          }
        }
      }
      return result;
    } };
  const messages = new Map(), logs = [], readCalls = []; let sequence = 0, time = 0, closeCount = 0, patchCount = 0, historyCalls = 0;
  const readback = (original, validateDelivery = true) => {
    const message = structuredClone(original);
    const card = JSON.parse(message.body.content);
    if (schema2Fallback && card.schema === '2.0') {
      // Feishu returns only this legacy fallback shape for schema-2.0 cards.
      message.body.content = JSON.stringify({ title: card.header.title.content, elements: [[
        { tag: 'img', image_key: 'img_fixture' },
        { tag: 'text', text: '请升级至最新版本客户端，以查看内容' },
      ]] });
      if (validateDelivery && message.root_id && invalidDelivery === 'title') message.body.content = JSON.stringify({ title: '[selftest] 💻 当前屏幕' });
      if (validateDelivery && message.root_id && invalidDelivery === 'thread') message.thread_id = 'omt_other';
      if (validateDelivery && message.root_id && invalidDelivery === 'type') message.msg_type = 'text';
      if (validateDelivery && message.root_id && invalidDelivery === 'id') message.message_id = 'om_other';
    }
    if (validateDelivery && message.root_id && message.msg_type === 'interactive' && invalidDelivery) {
      if (invalidDelivery === 'title') { const body = JSON.parse(message.body.content); body.header.title.content = 'wrong'; message.body.content = JSON.stringify(body); }
      if (invalidDelivery === 'thread') message.thread_id = 'omt_other';
      if (invalidDelivery === 'type') message.msg_type = 'text';
      if (invalidDelivery === 'id') message.message_id = 'om_other';
    }
    if (badReadback) message.body.content = '{}';
    return message;
  };
  const feishu = {
    ws: { getConnectionStatus: () => ({ state: wsFailed ? 'failed' : 'connected' }) },
    async start() {}, close() { closeCount++; },
    async send(_chatId, text) {
      const id = `om_${++sequence}`; messages.set(id, { message_id: id, thread_id: 'omt_fixture', msg_type: typeof text === 'string' ? 'text' : 'interactive', body: { content: JSON.stringify(typeof text === 'string' ? { text } : text) } }); return id;
    },
    async reply(topic, content, type = 'text') {
      const id = `om_${++sequence}`;
      messages.set(id, { message_id: id, root_id: topic, thread_id: 'omt_fixture', msg_type: type,
        body: { content: JSON.stringify(type === 'text' ? { text: content } : content) } }); return id;
    },
    async patch(id, card) { patchCount++; messages.get(id).body.content = JSON.stringify(card); },
    async getMessage(id) {
      readCalls.push(['get', id]);
      // Keep both starting-message and bot-root lookups available so denial exercises output readback.
      if (perIdDenied && messages.get(id)?.root_id) throw new FeishuError(230027);
      return readback(messages.get(id));
    },
    async threadMessages() {
      historyCalls++; readCalls.push(['list']);
      if (historyDenied) throw new FeishuError(historyDenied);
      // History must not mask an invalid per-id delivery response.
      return badReadback ? [] : [...messages.values()].map(message => readback(message, false));
    },
  };
  const code = await selftest({ config: { chatIds: ['oc_fixture'], operatorOpenIds: ['ou_fixture'], defaultCwd: '/tmp' },
    stateDir: dir, env: { HERDR_TCP: '127.0.0.1:49450' }, herdr, feishu, print: line => logs.push(line),
    sleep: async ms => { time += ms; await new Promise(resolve => setTimeout(resolve, 1)); }, now: () => time, timeoutMs: 5000 });
  assert.ok(fake.panes.has(untouched.pane_id)); assert.equal(fake.panes.size, 1);
  assert.equal(client.closed, true); assert.ok(closeCount > 0);
  assert.deepEqual(await readdir(dir), []);
  return { code, logs, patchCount, messages, readCalls, historyCalls, calls: fake.calls };
}

test('selftest uses real Bridge and socket schema, reads output back, patches cards, feeds card callback, keys and both close modes', async t => {
  const r = await run(t);
  assert.equal(r.code, 0, r.logs.join('\n')); assert.equal(r.logs.filter(l => l.startsWith('PASS')).length, 10);
  assert.ok(r.logs.some(line => line.includes('127.0.0.1:49450') && line.includes("may differ from the service's")));
  assert.ok(r.patchCount >= 3);
  assert.ok(r.calls.some(c => c.method === 'pane.send_keys' && c.params.keys.includes('ctrl+c')));
  assert.equal(r.calls.filter(c => c.method === 'pane.close').length, 1);
  for (const message of r.messages.values()) assert.ok(message.body.content.includes('[selftest]'));
  assert.ok(r.historyCalls > 0);
  const roots = [...r.messages.values()].filter(m => m.msg_type === 'text' && !m.root_id);
  assert.equal(roots.length, 1);
  assert.ok([...r.messages.values()].some(m => m.root_id === roots[0].message_id && m.msg_type === 'interactive'));
  const readIds = new Set(r.readCalls.filter(([method]) => method === 'get').map(([, id]) => id));
  for (const message of r.messages.values()) {
    if (!message.body.content.includes('模拟输入：')) assert.ok(readIds.has(message.message_id));
  }
});

for (const historyDenied of [undefined, 230027, 99991672, 99991676]) {
  test(`selftest verifies interaction cards with history denial ${historyDenied}`, async t => {
    const r = await run(t, { schema2Fallback: true, historyDenied });
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.logs.filter(line => line.startsWith('PASS')).length, 10);
    assert.ok(r.readCalls.some(([method, id]) => method === 'get' && r.messages.get(id)?.root_id));
    if (historyDenied) assert.equal(r.historyCalls, 1);
  });
}

for (const invalidDelivery of ['title', 'thread', 'type', 'id']) {
  test(`selftest rejects interaction card with incorrect delivered ${invalidDelivery}`, async t => {
    const r = await run(t, { schema2Fallback: true, invalidDelivery });
    assert.equal(r.code, 1);
    assert.ok(r.logs.includes('FAIL echo -> topic output read back'));
  });
}

test('selftest schema-2.0 fallback still requires the expected token in the sent output', async t => {
  const r = await run(t, { schema2Fallback: true, missedInterrupt: true });
  assert.equal(r.code, 1);
  assert.ok(r.logs.includes('FAIL /t k ctrl+c (interrupt verified)'));
});

for (const offset of [0, 3]) {
  test(`selftest reads stay within a tiny viewport and history buffer (scrollback=${offset})`, async t => {
    const r = await run(t, { scroll: { viewport_rows: 6, max_offset_from_bottom: offset } });
    assert.equal(r.code, 0, r.logs.join('\n'));
    const reads = r.calls.filter(c => c.method === 'pane.read');
    assert.ok(reads.length > 0);
    assert.ok(reads.every(c => c.params.lines <= 6 + offset));
    if (!offset) assert.ok(reads.every(c => c.params.source === 'visible'));
    else assert.ok(reads.some(c => c.params.source === 'recent_unwrapped' && c.params.lines === 9));
  });
}

for (const historyDenied of [230027, 99991672, 99991676]) {
  test(`selftest verifies replies and patched cards by id when history permission is denied (${historyDenied})`, async t => {
    const r = await run(t, { historyDenied });
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.logs.filter(l => l.startsWith('PASS')).length, 10);
    assert.equal(r.historyCalls, 1);
    assert.equal(r.logs.filter(l => l === 'NOTE history list needs im:message.group_msg (pending) — verified by message id instead').length, 1);
    const firstList = r.readCalls.findIndex(([method]) => method === 'list');
    assert.ok(r.readCalls.slice(0, firstList).some(([method, id]) => method === 'get' && r.messages.get(id)?.root_id));
    const readIds = new Set(r.readCalls.filter(([method]) => method === 'get').map(([, id]) => id));
    for (const message of r.messages.values()) {
      if (!message.body.content.includes('模拟输入：')) assert.ok(readIds.has(message.message_id));
    }
    assert.ok(r.patchCount >= 3);
  });
}

test('selftest fails and cleans owned panes when both history and per-id read permissions are denied', async t => {
  const r = await run(t, { historyDenied: 230027, perIdDenied: true });
  assert.equal(r.code, 1);
  assert.ok(r.logs.includes('FAIL echo -> topic output read back'));
  assert.equal(r.calls.filter(c => c.method === 'pane.close').length, 1);
  assert.ok(!r.logs.some(l => l.includes('verified by message id instead')));
});

test('selftest does not let available history hide a per-id read failure', async t => {
  const r = await run(t, { perIdDenied: true });
  assert.equal(r.code, 1);
  assert.ok(r.logs.includes('FAIL echo -> topic output read back'));
  assert.equal(r.historyCalls, 0);
});

test('selftest cannot pass on successful sends when Feishu readback lacks output; failure cleans only owned panes', async t => {
  const r = await run(t, { badReadback: true });
  assert.equal(r.code, 1); assert.ok(r.logs.includes('FAIL echo -> topic output read back'));
  assert.equal(r.calls.filter(c => c.method === 'pane.close').length, 1);
});

test('selftest detects missed Ctrl-C rather than accepting a successful key API call', async t => {
  const r = await run(t, { missedInterrupt: true });
  assert.equal(r.code, 1); assert.ok(r.logs.includes('FAIL /t k ctrl+c (interrupt verified)'));
});

test('selftest reads SDK connection state and fails before any pane creation when WS fails', async t => {
  const r = await run(t, { wsFailed: true });
  assert.equal(r.code, 1); assert.ok(r.logs.includes('FAIL WS connected (SDK state)'));
  assert.ok(!r.calls.some(c => c.method === 'workspace.create' || c.method === 'tab.create'));
});
