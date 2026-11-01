import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { selftest } from '../src/selftest.js';
import { HerdrClient } from '../src/herdr-client.js';
import { fakeHerdr } from './helpers.js';

async function run(t, { badReadback = false, missedInterrupt = false, wsFailed = false } = {}) {
  const dir = await mkdtemp(new URL('../.test-selftest-', import.meta.url));
  const fake = await fakeHerdr();
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const client = new HerdrClient({ endpoint: fake.endpoint, timeoutMs: 1000 });
  const untouched = fake.create(); // A desktop pane which must survive every success/failure path.
  const pending = new Map(), sleeping = new Set();
  const herdr = { subscribe: (...args) => client.subscribe(...args), close: () => client.close(),
    async request(method, params = {}) {
      const result = await client.request(method, params);
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
  const messages = new Map(), logs = []; let sequence = 0, time = 0, closeCount = 0, patchCount = 0;
  const feishu = {
    ws: { getConnectionStatus: () => ({ state: wsFailed ? 'failed' : 'connected' }) },
    async start() {}, close() { closeCount++; },
    async send(_chatId, text) {
      const id = `om_${++sequence}`; messages.set(id, { message_id: id, thread_id: 'omt_fixture', msg_type: 'text', body: { content: JSON.stringify({ text }) } }); return id;
    },
    async reply(topic, content, type = 'text') {
      const id = `om_${++sequence}`;
      messages.set(id, { message_id: id, root_id: topic, thread_id: 'omt_fixture', msg_type: type,
        body: { content: JSON.stringify(type === 'text' ? { text: content } : content) } }); return id;
    },
    async patch(id, card) { patchCount++; messages.get(id).body.content = JSON.stringify(card); },
    async getMessage(id) { return structuredClone(messages.get(id)); },
    async threadMessages() { return badReadback ? [] : structuredClone([...messages.values()]); },
  };
  const code = await selftest({ config: { chatIds: ['oc_fixture'], operatorOpenIds: ['ou_fixture'], defaultCwd: '/tmp' },
    stateDir: dir, env: { HERDR_TCP: '127.0.0.1:49450' }, herdr, feishu, print: line => logs.push(line),
    sleep: async ms => { time += ms; await new Promise(resolve => setTimeout(resolve, 1)); }, now: () => time, timeoutMs: 5000 });
  assert.ok(fake.panes.has(untouched.pane_id)); assert.equal(fake.panes.size, 1);
  assert.equal(client.closed, true); assert.ok(closeCount > 0);
  assert.deepEqual(await readdir(dir), []);
  return { code, logs, patchCount, messages, calls: fake.calls };
}

test('selftest uses real Bridge and socket schema, reads output back, patches cards, feeds card callback, keys and both close modes', async t => {
  const r = await run(t);
  assert.equal(r.code, 0, r.logs.join('\n')); assert.equal(r.logs.filter(l => l.startsWith('PASS')).length, 10);
  assert.ok(r.logs.some(line => line.includes('127.0.0.1:49450') && line.includes("may differ from the service's")));
  assert.ok(r.patchCount >= 3);
  assert.ok(r.calls.some(c => c.method === 'pane.send_keys' && c.params.keys.includes('ctrl+c')));
  assert.equal(r.calls.filter(c => c.method === 'pane.close').length, 1);
  for (const message of r.messages.values()) assert.ok(message.body.content.includes('[selftest]'));
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
