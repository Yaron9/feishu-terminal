import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { PiTranscript, piSessionDir } from '../src/transcripts/pi.js';
import { hcFiles, localFiles } from '../src/transcripts/files.js';
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
    if (cmd === 'scan') {
      const [depthStr, sinceStr, dirSrc, fileSrc] = argv.slice(5);
      const depth = Number(depthStr), since = Number(sinceStr);
      const dirRe = dirSrc ? new RegExp(dirSrc) : null;
      const fileRe = fileSrc ? new RegExp(fileSrc) : null;
      const root = arg === '~' || arg.startsWith('~/') ? '/Users/example' + arg.slice(1) : arg;
      const out = [];
      const walk = (dir, remaining) => {
        for (const d of dirs) if (dirname(d) === dir) {
          const name = basename(d);
          if (remaining > 0 && (!dirRe || dirRe.test(name))) walk(d, remaining - 1);
        }
        for (const [p, content] of files) if (dirname(p) === dir) {
          const name = basename(p);
          if (remaining === 0 && (!fileRe || fileRe.test(name))) {
            const mtimeMs = 1000;
            if (mtimeMs >= since) out.push({ path: p, name, mtimeMs, size: Buffer.byteLength(content) });
          }
        }
      };
      walk(root, depth);
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
  const pi = new PiTranscript({ files: hcFiles('mac', remote.client, { scanTtl: 0 }) });
  const bridge = new Bridge({ backend, feishu, store, now, adapters: { pi },
    config: { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: '/Users/example', stateFile: store.file, auditFile: join(root, 'audit.jsonl') },
    onError: e => errors.push(e) });
  await bridge.start({ timers: false });
  const terminal = hc.create({ address: 'mac/t42', created_ms: 0, cwd: '/Users/example/sample-project', output: 'Starting Pi',
    foreground: { pid: 42, name: 'pi', argv: ['pi'], cwd: '/Users/example/sample-project' }, reported: true, status: { app: 'pi', state: 'working' } });
  t.after(async () => { await bridge.stop(); await hc.close(); await rm(root, { recursive: true, force: true }); });
  return { bridge, store, feishu, hc, remote, terminal, errors, now,
    advance(ms) { time += ms; },
    sessionPath: id => `/Users/example/.pi/agent/sessions/--Users-example-sample-project--/1970-01-01_${id}.jsonl` };
}

test('remote pi adapter reads a turn through hc and advances its line cursor without a full reread', async t => {
  const remote = remoteFs();
  const path = '/Users/example/.pi/agent/sessions/--Users-example-sample-project--/1970-01-01_flow.jsonl';
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
  assert.equal(homes.length, 0, 'home is never a separate exec: the scan expands ~');
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

test('one locate makes a single scan exec and reads only candidate files', async t => {
  const remote = remoteFs();
  const path = '/Users/example/.pi/agent/sessions/--Users-example-sample-project--/1970-01-01_flow.jsonl';
  remote.addFile(path, lines([sessionLine('flow'), msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')]));
  remote.addFile('/Users/example/.pi/agent/sessions/--Users-example-sample-project--/notes.txt', 'not a session');
  const adapter = new PiTranscript({ files: hcFiles('mac', remote.client) });
  const pane = { pane_id: 'hc:mac/t42', cwd: '/Users/example/sample-project' };
  const binding = { chatId: 'a', topicId: 'b', cliCommandSentAt: 0, sentInputs: [input('hello')] };
  assert.equal(await adapter.locate(pane, binding, [binding]), path);
  const execs = remote.calls.filter(c => c.method === 'machine.exec');
  assert.equal(execs.filter(c => c.params.argv?.[3] === 'scan').length, 1, 'one scan exec per locate');
  assert.equal(execs.filter(c => c.params.argv?.[3] === 'list').length, 0, 'no per-directory list execs');
  assert.equal(execs.filter(c => c.params.argv?.[3] === 'stat').length, 0, 'no per-file stat execs');
  const reads = remote.calls.filter(c => c.method === 'file.read');
  assert.ok(reads.every(c => c.params.path === path), 'file.read only for candidate session files');
});

test('the scan is cached per machine within one poll interval', async t => {
  const remote = remoteFs();
  const path = '/Users/example/.pi/agent/sessions/--Users-example-sample-project--/1970-01-01_flow.jsonl';
  remote.addFile(path, lines([sessionLine('flow'), msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')]));
  const adapter = new PiTranscript({ files: hcFiles('mac', remote.client) });
  const pane = { pane_id: 'hc:mac/t42', cwd: '/Users/example/sample-project' };
  const binding = { chatId: 'a', topicId: 'b', cliCommandSentAt: 0, sentInputs: [input('hello')] };
  assert.equal(await adapter.locate(pane, binding, [binding]), path);
  assert.equal(await adapter.locate(pane, binding, [binding]), path);
  const scans = remote.calls.filter(c => c.method === 'machine.exec' && c.params.argv?.[3] === 'scan');
  assert.equal(scans.length, 1, 'a second locate within the interval reuses the cached scan');
});

test('the local port locates a local pi session exactly as before', async t => {
  const root = await mkdtemp(new URL('../.test-w16r-local-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '.pi', 'agent', 'sessions', '--tmp--'); await mkdir(dir, { recursive: true });
  const path = join(dir, '1970-01-01_flow.jsonl');
  await writeFile(path, lines([{ type: 'session', id: 'flow', cwd: '/tmp', timestamp: ts, version: 3 }, msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')]));
  const adapter = new PiTranscript({ home: root });
  const pane = { pane_id: 'w1:p1', cwd: '/tmp' };
  const binding = { chatId: 'a', topicId: 'b', cliCommandSentAt: 0, sentInputs: [input('hello')] };
  assert.equal(await adapter.locate(pane, binding, [binding]), path);
  assert.equal(adapter.sessions.get(path).sessionId, 'flow');
  const scanned = await localFiles({ home: root }).scan(join(root, '.pi', 'agent', 'sessions'), 1, { since: 0, directory: null, file: '\\.jsonl$' });
  assert.deepEqual(scanned.map(c => c.name), ['1970-01-01_flow.jsonl'], 'local scan returns the same candidate');
});

test('a remote scan failure falls back without throwing', async t => {
  const remote = remoteFs();
  const path = '/Users/example/.pi/agent/sessions/--Users-example-sample-project--/1970-01-01_flow.jsonl';
  remote.addFile(path, lines([sessionLine('flow'), msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')]));
  const adapter = new PiTranscript({ files: hcFiles('mac', remote.client) });
  const pane = { pane_id: 'hc:mac/t42', cwd: '/Users/example/sample-project' };
  const binding = { chatId: 'a', topicId: 'b', cliCommandSentAt: 0, sentInputs: [input('hello')] };
  await adapter.files.home; // resolve home once so the failure lands on the scan
  remote.fail('machine.exec', 'hc_exec_failed');
  assert.equal(await adapter.locate(pane, binding, [binding]), null);
});

test('piSessionDir maps a cwd to the pi session directory name', () => {
  assert.equal(piSessionDir('/Users/example/sample-project'), '--Users-example-sample-project--');
  assert.equal(piSessionDir('/Users/example'), '--Users-example--');
  assert.equal(piSessionDir('/private/tmp'), '--private-tmp--');
  assert.equal(piSessionDir('/Users/example/AGI/MetaMe'), '--Users-example-AGI-MetaMe--');
  assert.equal(piSessionDir('/Users/example/'), '--Users-example--');
  assert.equal(piSessionDir('D:\\work\\superagent-ft\\work\\live-w16s3\\cwd'), '--D--work-superagent-ft-work-live-w16s3-cwd--');
  assert.equal(piSessionDir(''), null);
  assert.equal(piSessionDir('/'), null);
});

test('a locate narrowed by cwd scans only the current session directory, not every history file', async t => {
  const remote = remoteFs();
  const target = '/Users/example/.pi/agent/sessions/--Users-example-sample-project--/1970-01-01_flow.jsonl';
  remote.addFile(target, lines([sessionLine('flow'), msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')]));
  // Many historical sessions in other cwd directories must not be touched.
  for (let i = 0; i < 60; i++) {
    remote.addFile(`/Users/example/.pi/agent/sessions/--Users-example-other-${i}--/1970-01-01_hist${i}.jsonl`,
      lines([{ ...sessionLine(`hist${i}`), cwd: `/Users/example/other-${i}` }, msg('user', 'old'), msg('assistant', 'old', 'stop')]));
  }
  const adapter = new PiTranscript({ files: hcFiles('mac', remote.client) });
  const pane = { pane_id: 'hc:mac/t42', cwd: '/Users/example/sample-project' };
  const binding = { chatId: 'a', topicId: 'b', cliCommandSentAt: 0, sentInputs: [input('hello')] };
  assert.equal(await adapter.locate(pane, binding, [binding]), target);
  const scans = remote.calls.filter(c => c.method === 'machine.exec' && c.params.argv?.[3] === 'scan');
  assert.equal(scans.length, 1, 'one scan exec per locate');
  assert.equal(scans[0].params.argv[7], '^--Users-example-sample-project--$', 'scan narrowed to the cwd-derived directory');
  const reads = remote.calls.filter(c => c.method === 'file.read');
  assert.ok(reads.every(c => c.params.path === target), 'only the current candidate is read');
  assert.ok(reads.length <= 3, `bounded file.read calls (got ${reads.length})`);
});

test('locate reads a candidate in one call even with a long history (early break)', async t => {
  const remote = remoteFs();
  const path = '/Users/example/.pi/agent/sessions/--Users-example-sample-project--/1970-01-01_flow.jsonl';
  const records = [sessionLine('flow'), msg('user', 'hello'), msg('assistant', 'clean answer', 'stop')];
  for (let i = 0; i < 500; i++) records.push(msg('assistant', `filler ${i}`, 'stop'));
  remote.addFile(path, lines(records));
  const adapter = new PiTranscript({ files: hcFiles('mac', remote.client) });
  const pane = { pane_id: 'hc:mac/t42', cwd: '/Users/example/sample-project' };
  const binding = { chatId: 'a', topicId: 'b', cliCommandSentAt: 0, sentInputs: [input('hello')] };
  assert.equal(await adapter.locate(pane, binding, [binding]), path);
  const reads = remote.calls.filter(c => c.method === 'file.read' && c.params.path === path);
  assert.equal(reads.length, 1, 'one file.read locates the candidate (early break, no EOF probe)');
  assert.equal(reads[0].params.offset, 1, 'read starts from the top once');
});
