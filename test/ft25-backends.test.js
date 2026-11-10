import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeHc } from './hc-helper.js';
import { fakeHerdr, eventually } from './helpers.js';
import { HcBackend, HcClient, hcEndpoint } from '../src/backends/hc.js';
import { HerdrBackend } from '../src/backends/herdr.js';
import { HerdrClient } from '../src/herdr-client.js';
import { Backends } from '../src/backends/index.js';

for (const kind of ['herdr', 'hc']) test(`backend contract: ${kind} list/get/read/create/text/keys/events/identity/status/close`, async t => {
  const fake = await (kind === 'hc' ? fakeHc() : fakeHerdr());
  const b = kind === 'hc' ? new HcBackend(new HcClient({ endpoint: fake.endpoint, timeoutMs: 300 })) :
    new HerdrBackend(new HerdrClient({ endpoint: fake.endpoint, timeoutMs: 300 }));
  t.after(async () => { b.dispose(); await fake.close(); });
  const term = await b.create(null, '/tmp'), id = term.pane_id;
  assert.deepEqual((await b.list()).map(p => p.pane_id), [id]);
  const found = await b.get(id, {}); assert.deepEqual(b.identity(found), b.identity(term));
  assert.ok(b.identity(found).terminalId); assert.equal(b.status(found), 'unknown');
  assert.equal(typeof (await b.read(id, { source: 'visible' })).read.text, 'string');
  assert.equal(typeof (await b.read(id, { source: 'recent' })).read.text, 'string');
  await b.sendText(id, 'echo hi', { submit: true });
  await b.sendText(id, '中文 RAW\n+/ !');
  await b.sendKeys(id, ['down', 'enter']);
  const events = [];
  const stop = b.subscribe([id], e => events.push(e)); t.after(stop);
  await eventually(() => fake.subscribers.size > 0);
  if (kind === 'hc') fake.emit(id.slice(3)); else fake.output(id, 'changed');
  await eventually(() => events.some(e => e.data.pane_id === id));
  if (kind === 'hc') {
    assert.deepEqual(fake.raw, ['\x1b[200~中文 RAW\n+/ !\x1b[201~']);
    assert.equal(fake.calls.filter(c => c.method === 'terminal.send').length, 1);
    assert.equal(fake.calls.filter(c => c.method === 'terminal.keys').length, 1, 'send already enters');
    assert.equal(b.processOf(found), found.foreground.pid);
  }
  await b.close(id); assert.equal((await b.list()).length, 0);
});

test('namespaced remote core IDs, raw legacy IDs, core identity and backend failure isolation', async t => {
  const hc = await fakeHc(), herdr = await fakeHerdr(), logs = [];
  const core = new HcBackend(new HcClient({ endpoint: hc.endpoint, timeoutMs: 100 }));
  const legacy = new HerdrBackend(new HerdrClient({ endpoint: herdr.endpoint, timeoutMs: 100 }));
  const backend = new Backends([core, legacy], { onError: code => logs.push(code) });
  t.after(async () => { backend.dispose(); await hc.close(); await herdr.close(); });
  hc.create({ address: 'mac/t3' }); const old = herdr.create();
  assert.deepEqual((await backend.list()).map(p => p.pane_id), ['hc:mac/t3', old.pane_id]);
  assert.deepEqual(backend.identity(await backend.get(old.pane_id, {})), { terminalId: old.terminal_id, workspaceId: old.workspace_id, tabId: old.tab_id });
  const before = backend.identity(await backend.get('hc:mac/t3'));
  hc.coreId('replaced'); assert.notDeepEqual(backend.identity(await backend.get('hc:mac/t3')), before);
  hc.fail('terminal.list', 'unavailable'); assert.deepEqual((await backend.list()).map(p => p.pane_id), [old.pane_id]);
  herdr.fail('pane.list', 'unavailable'); assert.deepEqual((await backend.list()).map(p => p.pane_id), ['hc:mac/t3']);
  assert.ok(logs.some(l => l.startsWith('backend_unreachable hc '))); assert.ok(logs.some(l => l.startsWith('backend_unreachable herdr ')));
});

test('hc reported status wins; unreported screens use menus, spinners and prompt heuristics', () => {
  const b = new HcBackend();
  assert.equal(b.status({ reported: true, status: { state: 'idle' } }, '✻ Thinking…'), 'idle');
  assert.equal(b.status({ reported: true, status: { state: 'blocked' } }), 'blocked');
  assert.equal(b.status({}, '✻ Thinking…'), 'working');
  assert.equal(b.status({}, '❯ '), 'idle');
  assert.equal(b.status({}, 'something'), 'unknown');
  b.dispose();
  assert.equal(hcEndpoint({ XDG_RUNTIME_DIR: '/run/user/77' }, 'linux').path.replaceAll('\\', '/'), '/run/user/77/herdr-core/default.sock');
});

test('hc quiet delay and started:false acknowledge once; lost responses are not retried', async t => {
  const fake = await fakeHc(); fake.create(); fake.delay(80); fake.started(false);
  const b = new HcBackend(new HcClient({ endpoint: fake.endpoint, timeoutMs: 20, writeTimeoutMs: 250 }));
  t.after(async () => { b.dispose(); await fake.close(); });
  assert.equal((await b.sendText('hc:t1', 'once', { submit: true })).started, false);
  fake.drop('terminal.send'); await assert.rejects(b.sendText('hc:t1', 'ambiguous', { submit: true }));
  assert.equal(fake.calls.filter(c => c.method === 'terminal.send').length, 2);
});

test('hc isolates a dropped send from concurrent create and remains usable', async t => {
  const fake = await fakeHc(); fake.create(); fake.drop('terminal.send');
  const b = new HcBackend(new HcClient({ endpoint: fake.endpoint, timeoutMs: 300 }));
  t.after(async () => { b.dispose(); await fake.close(); });
  const [created, sent] = await Promise.allSettled([b.create('pi', '/tmp'), b.sendText('hc:t1', 'hello', { submit: true })]);
  assert.equal(created.status, 'fulfilled'); assert.equal(sent.status, 'rejected');
  assert.ok((await b.list()).some(item => item.pane_id === created.value.pane_id));
  assert.equal((await b.sendText('hc:t1', 'next', { submit: true })).turn, 0);
});

test('hc named creation, finished inspection and removal preserve terminal identity', async t => {
  const fake = await fakeHc(), b = new HcBackend(new HcClient({ endpoint: fake.endpoint, timeoutMs: 300 }));
  t.after(async () => { b.dispose(); await fake.close(); });
  const terminal = await b.create('pi', '/tmp', { name: 'w2-fixture', labels: { 'ft.woken': '1', session: 'fixture' } });
  const run = fake.calls.find(c => c.method === 'terminal.run');
  assert.equal(run.params.name, 'w2-fixture'); assert.equal(run.params.labels['ft.woken'], '1');
  await assert.rejects(b.remove(terminal.pane_id), { code: 'live' });
  await b.close(terminal.pane_id);
  await assert.rejects(b.get(terminal.pane_id), { code: 'terminal_finished' });
  const finished = await b.inspect(terminal.pane_id);
  assert.equal(finished.state, 'finished'); assert.deepEqual(b.identity(finished), b.identity(terminal));
  await b.remove(terminal.pane_id); await assert.rejects(b.inspect(terminal.pane_id), { code: 'not_found' });
});
