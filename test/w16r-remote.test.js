import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { PiTranscript } from '../src/transcripts/pi.js';
import { hcFiles } from '../src/transcripts/files.js';
import { inputHash, normalizeInput } from '../src/input-echo.js';
import { fakeHc } from './hc-helper.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend, HcClient } from '../src/backends/hc.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { mockFeishu, message } from './helpers.js';

const ts = '1970-01-01T00:00:01.000Z';
const msg = (role, content, stopReason) => ({ type: 'message', id: role, timestamp: ts, message: { role, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, stopReason } });
const lines = records => records.map(r => JSON.stringify(r)).join('\n') + '\n';
const input = text => ({ id: text, hash: inputHash(text), prefix: normalizeInput(text).slice(0, 64), length: normalizeInput(text).length, sentAt: 0, expires: 600000 });
const sessionLine = id => ({ type: 'session', id, cwd: '/Users/example/sample-project', timestamp: ts, version: 3 });

// A fake remote machine served through hc: files (content strings), directory
// listing and stat, plus a recorded call log for the no-full-reread check.
function remoteFs() {
  const files = new Map(); const dirs = new Set(); const calls = []; let fail = null;
  const b64 = s => Buffer.from(s ?? '', 'utf8').toString('base64');
  const addParents = path => { let d = dirname(path); while (d !== dirname(d)) { dirs.add(d); d = dirname(d); } };
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (fail?.method === method) { const c = fail; fail = null; const e = new Error('fixture failure'); e.code = c.code; throw e; }
      if (method === 'file.read') return read(params);
      if (method === 'machine.exec') return exec(params);
      throw Object.assign(new Error('unknown'), { code: 'unknown_method' });
    },
  };
  function read({ path, offset = 1, limit }) {
    const content = files.get(path);
    if (content === undefined) { const e = new Error('no such file'); e.code = 'not_found'; throw e; }
    const total = content === '' ? 0 : content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
    if (offset === 0 || (offset > total && offset > 1)) { const e = new Error('offset past EOF'); e.code = 'invalid_params'; throw e; }
    const take = limit === undefined ? total : limit;
    const start = offset - 1, end = Math.min(total, start + take);
    const chosen = content.split('\n').slice(start, end);
    const given = chosen.length;
    const text = given === 0 ? '' : chosen.join('\n') + (content.endsWith('\n') && end === total ? '\n' : '');
    return { text, first: offset, last: offset + given - 1, lines: total };
  }
  function exec({ argv }) {
    const [cmd, arg] = argv.slice(3);
    if (cmd === 'home') return { code: 0, stdout: b64('/Users/example'), stderr: b64(''), truncated: false, timed_out: false, ms: 1 };
    if (cmd === 'list') {
      const out = [];
      for (const d of dirs) if (dirname(d) === arg) out.push({ name: basename(d), isDirectory: true, isFile: false });
      for (const [p] of files) if (dirname(p) === arg) out.push({ name: basename(p), isDirectory: false, isFile: true });
      return { code: 0, stdout: b64(JSON.stringify(out)), stderr: b64(''), truncated: false, timed_out: false, ms: 1 };
    }
    if (cmd === 'stat') {
      if (files.has(arg)) return { code: 0, stdout: b64(JSON.stringify({ isFile: true, isDirectory: false, size: Buffer.byteLength(files.get(arg)), mtimeMs: 1000, dev: 1, ino: 2, birthtimeMs: 3 })), stderr: b64(''), truncated: false, timed_out: false, ms: 1 };
      if (dirs.has(arg)) return { code: 0, stdout: b64(JSON.stringify({ isFile: false, isDirectory: true, size: 0, mtimeMs: 1000, dev: 1, ino: 2, birthtimeMs: 3 })), stderr: b64(''), truncated: false, timed_out: false, ms: 1 };
      return { code: 1, stdout: b64(''), stderr: b64('no such file'), truncated: false, timed_out: false, ms: 1 };
    }
    return { code: 1, stdout: b64(''), stderr: b64('bad cmd'), truncated: false, timed_out: false, ms: 1 };
  }
  return {
    client, calls, files,
    addFile(path, content) { files.set(path, content); addParents(path); },
    append(path, content) { files.set(path, (files.get(path) ?? '') + content); },
    fail(method, code) { fail = { method, code }; },
  };
}

async function remoteHarness(t) {
  const root = await mkdtemp(new URL('../.test-w16r-', import.meta.url));
  const remote = remoteFs();
  const hc = await fakeHc();
  let time = 0;
  const now = () => time;
  const store = await new Store(join(root, 'state.json')).load();
  const feishu = mockFeishu(now), errors = [];
  const backend = new Backends([new HcBackend(new HcClient({ endpoint: hc.endpoint, timeoutMs: 300, writeTimeoutMs: 1000, reconnectMs: 10 }))], { onError: e => errors.push(e) });
  const pi = new PiTranscript({ files: hcFiles('mac', remote.client) });
  const bridge = new Bridge({ backend, feishu, store, now, adapters: { pi },
    config: { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: '/Users/example', stateFile: store.file, auditFile: join(root, 'audit.jsonl') },
    onError: e => errors.push(e) });
  await bridge.start({ timers: false });
  const terminal = hc.create({ address: 'mac/t42', created_ms: 0, cwd: '/Users/example/sample-project', output: 'Starting Pi',
    foreground: { pid: 42, name: 'pi', argv: ['pi'], cwd: '/Users/example/sample-project' }, reported: true, status: { app: 'pi', state: 'working' } });
  t.after(async () => { await bridge.stop(); await hc.close(); await rm(root, { recursive: true, force: true }); });
  return { bridge, store, feishu, hc, remote, terminal, errors, now,
    advance(ms) { time += ms; },
    sessionPath: id => `/Users/example/.pi/agent/sessions/--tmp--/1970-01-01_${id}.jsonl` };
}

test('remote pi adapter reads a turn through hc and advances its line cursor without a full reread', async t => {
  const remote = remoteFs();
  const path = '/Users/example/.pi/agent/sessions/--tmp--/1970-01-01_flow.jsonl';
  remote.addFile(path, lines([sessionLine('flow'), msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')]));
  const adapter = new PiTranscript({ files: hcFiles('mac', remote.client) });
  const pane = { pane_id: 'hc:mac/t42', cwd: '/Users/example/sample-project' };
  const binding = { chatId: 'a', topicId: 'b', cliCommandSentAt: 0, sentInputs: [input('hello')] };
  assert.equal(await adapter.locate(pane, binding, [binding]), path);
  assert.equal(adapter.sessions.get(path).sessionId, 'flow');
  const first = await adapter.read(path, null);
  assert.deepEqual(first.items.map(i => i.role), ['user', 'assistant', 'turn_end']);
  assert.equal(first.items.find(i => i.role === 'assistant').text, 'clean answer');
  const off = first.cursor.offset;
  assert.ok(off > 1, 'cursor advanced past the first line');
  remote.append(path, lines([msg('user', 'second'), msg('assistant', 'second answer', 'stop')]));
  const second = await adapter.read(path, first.cursor);
  assert.deepEqual(second.items.map(i => i.role), ['user', 'assistant', 'turn_end']);
  assert.equal(second.items.find(i => i.role === 'assistant').text, 'second answer');
  // Idle poll at EOF returns no items and never rereads the whole file.
  const readsBeforeIdle = remote.calls.filter(c => c.method === 'file.read' && c.params.path === path).length;
  const idle = await adapter.read(path, second.cursor);
  assert.deepEqual(idle.items, []);
  assert.equal(idle.cursor.offset, second.cursor.offset, 'idle cursor does not move');
  const readsAfterIdle = remote.calls.filter(c => c.method === 'file.read' && c.params.path === path).slice(readsBeforeIdle);
  assert.ok(readsAfterIdle.every(c => c.params.offset !== 1), 'idle poll never rereads from line 1');
  // No full reread: reads beyond the first turn start from the saved offset.
  const reads = remote.calls.filter(c => c.method === 'file.read' && c.params.path === path);
  assert.ok(reads.some(c => c.params.offset === 1), 'initial locate reads from the top once');
  assert.ok(reads.every(c => c.params.offset === undefined || c.params.offset >= 1), 'offsets are valid');
  assert.ok(reads.some(c => c.params.offset === off), 'a later read resumes at the saved line cursor');
  const homes = remote.calls.filter(c => c.method === 'machine.exec' && c.params.argv?.[3] === 'home');
  assert.equal(homes.length, 1, 'home is resolved once per machine');
});

test('remote pi topic streams one clean turn card per prompt and later cards exclude earlier answers', async t => {
  const h = await remoteHarness(t);
  await h.bridge.handle(message('/t open hc:mac/t42', 'open'));
  h.advance(2000); await h.bridge.tick();
  const binding = () => h.store.forPane('hc:mac/t42');
  const topic = binding().topicId;
  await h.store.update('oc_test', topic, { cliCommandSentAt: 0 });
  await h.bridge.handle(message('hello', 'm1', topic));
  h.remote.addFile(h.sessionPath('flow'), lines([sessionLine('flow'), msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')]));
  h.advance(2000); await h.bridge.tick();
  let b = binding();
  assert.equal(b.sessionId, 'flow'); assert.equal(b.sessionSource, 'verified');
  const rendered = id => JSON.stringify(h.feishu.calls.findLast(c => c.id === id && ['reply', 'patch'].includes(c.type)));
  const first = b.cardId; assert.match(rendered(first), /clean answer/); assert.match(rendered(first), /Pi/);
  await h.bridge.handle(message('second', 'm2', topic));
  h.remote.append(h.sessionPath('flow'), lines([{ ...msg('user', 'second'), timestamp: new Date(h.now()).toISOString() }, msg('assistant', 'second answer', 'stop')]));
  h.advance(2000); await h.bridge.tick();
  b = binding();
  assert.notEqual(b.cardId, first);
  const secondCard = rendered(b.cardId);
  assert.match(secondCard, /second answer/); assert.doesNotMatch(secondCard, /clean answer/);
  assert.doesNotMatch(secondCard, /```|Starting Pi/);
  assert.deepEqual(h.errors, []);
});

test('adapter sets are chosen per machine and cached; local terminals stay local', async t => {
  const root = await mkdtemp(new URL('../.test-w16r-', import.meta.url));
  const hc = await fakeHc();
  const store = await new Store(join(root, 'state.json')).load();
  const backend = new Backends([new HcBackend(new HcClient({ endpoint: hc.endpoint, timeoutMs: 300 }))]);
  const bridge = new Bridge({ backend, feishu: mockFeishu(() => 0), store,
    config: { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: '/tmp', stateFile: store.file, auditFile: join(root, 'audit.jsonl') } });
  t.after(async () => { await bridge.stop(); await hc.close(); await rm(root, { recursive: true, force: true }); });
  const local = bridge.adaptersFor('w1:p1');
  assert.ok(local.pi instanceof PiTranscript);
  const mac = bridge.adaptersFor('hc:mac/t42');
  assert.ok(mac.pi instanceof PiTranscript);
  assert.notEqual(local, mac, 'a remote machine gets its own adapter set');
  assert.equal(bridge.adaptersFor('hc:mac/t7'), mac, 'one adapter set per machine');
  assert.equal(bridge.adaptersFor('w1:p2'), local, 'the local adapter set is shared');
});

test('a remote read failure falls back to screen mode and records one audit entry', async t => {
  const h = await remoteHarness(t);
  await h.bridge.handle(message('/t open hc:mac/t42', 'open'));
  h.advance(2000); await h.bridge.tick();
  const topic = h.store.forPane('hc:mac/t42').topicId;
  await h.store.update('oc_test', topic, { cliCommandSentAt: 0 });
  await h.bridge.handle(message('hello', 'm1', topic));
  h.remote.addFile(h.sessionPath('flow'), lines([sessionLine('flow'), msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')]));
  h.advance(2000); await h.bridge.tick();
  assert.equal(h.store.forPane('hc:mac/t42').sessionId, 'flow', 'session located before the failure');
  h.remote.fail('file.read', 'not_found');
  h.advance(2000); await h.bridge.tick();
  assert.ok(h.errors.some(e => e.includes('transcript_unavailable')), 'remote failure recorded');
  assert.equal(h.store.forPane('hc:mac/t42').frozen, undefined, 'binding stays active in screen mode');
});
