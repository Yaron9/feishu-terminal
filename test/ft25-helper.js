import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend, HcClient } from '../src/backends/hc.js';
import { HerdrBackend } from '../src/backends/herdr.js';
import { HerdrClient } from '../src/herdr-client.js';
import { ClaudeTranscript, projectDirectory } from '../src/transcripts/claude.js';
import { SessionFollow } from '../src/session-follow.js';
import { fakeHerdr, mockFeishu } from './helpers.js';
import { fakeHc } from './hc-helper.js';

export async function coreHarness(t, { sessionFollow = 'newest', survive = false } = {}) {
  const root = await mkdtemp(new URL('../.test-ft25-', import.meta.url));
  const proc = join(root, 'proc'), sessions = join(root, '.claude', 'sessions'), cwd = '/tmp/project';
  const project = join(root, '.claude', 'projects', projectDirectory(cwd));
  await mkdir(sessions, { recursive: true }); await mkdir(project, { recursive: true });
  await mkdir(join(sessions, '999.key')); // Opening keys would fail.
  const hc = await fakeHc(), herdr = await fakeHerdr(), kills = [], audits = [], errors = [];
  let time = Date.parse('2026-11-02T00:00:00Z'), onKill = () => {}, auditHook = () => {};
  const now = () => time;
  const store = await new Store(join(root, 'state.json')).load(), feishu = mockFeishu(now);
  const backend = new Backends([new HcBackend(new HcClient({ endpoint: hc.endpoint, timeoutMs: 300, writeTimeoutMs: 1000, reconnectMs: 10 })),
    new HerdrBackend(new HerdrClient({ endpoint: herdr.endpoint, timeoutMs: 300, reconnectMs: 10 }))], { onError: e => errors.push(e) });
  const follow = new SessionFollow({ home: root, procRoot: proc, now, sleep: async ms => { time += ms; },
    kill(pid, signal) { kills.push({ pid, signal }); onKill(pid, signal); if (!survive) {
      unlinkSync(join(proc, String(pid), 'comm')); unlinkSync(join(proc, String(pid), 'stat'));
    } } });
  const config = { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: cwd, sessionFollow,
    stateFile: store.file, auditFile: join(root, 'audit.jsonl') };
  const bridge = new Bridge({ backend, feishu, store, config, now, adapters: { claude: new ClaudeTranscript({ home: root, procRoot: proc }) },
    sessionFollow: follow, audit: async r => { audits.push(r); await auditHook(r); }, onError: e => errors.push(e) });
  await bridge.start({ timers: false });
  t.after(async () => { await bridge.stop(); await hc.close(); await herdr.close(); await rm(root, { recursive: true, force: true }); });
  const process = async (pid, start, terminalId, { comm = 'claude', sessionId = 'same' } = {}) => {
    const base = join(proc, String(pid)); await mkdir(base, { recursive: true });
    await writeFile(join(base, 'comm'), comm + '\n');
    await writeFile(join(base, 'environ'), `SECRET=never-log\0${terminalId ? terminalId.startsWith('hc:') ? `HC_TERMINAL_ID=${terminalId.slice(3)}` : `HERDR_PANE_ID=${terminalId}` : ''}\0`);
    await writeFile(join(base, 'stat'), `${pid} (claude with spaces) S ${Array(18).fill('0').join(' ')} ${start} 0`);
    await writeFile(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, other: 'never-log' }));
    const file = join(project, `${sessionId}.jsonl`);
    await appendFile(file, ''); return file;
  };
  return { root, proc, sessions, project, hc, herdr, kills, audits, errors, now, store, bridge, feishu, backend, follow, config, process,
    advance(ms = 2000) { time += ms; }, onKill(fn) { onKill = fn; }, auditHook(fn) { auditHook = fn; },
    async records(records, id = 'same') { await appendFile(join(project, `${id}.jsonl`), records.map(r => JSON.stringify(r) + '\n').join('')); },
    async poll() { time += 2000; await bridge.tick(); },
  };
}
