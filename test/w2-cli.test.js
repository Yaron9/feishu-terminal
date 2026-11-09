import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_TABLE, lookupCli, probeClaude, probeCodex, probePi, resumeSessionId } from '../src/cli-table.js';
import { hcEndpoint } from '../src/backends/hc.js';

test('table matches hc agent fields and describes resume, readiness and exits', () => {
  assert.equal(lookupCli({ status: { app: 'claude-code' } }).cli, 'claude');
  assert.equal(lookupCli({ agent: 'pi' }).cli, 'pi');
  assert.equal(lookupCli({ agent: 'unknown', foreground: { name: 'codex' } }), null);
  assert.deepEqual(CLI_TABLE.map(x => x.resume), ['claude --resume {id}', 'codex resume {id} --no-daemon -c check_for_update_on_startup=false', 'pi --session {id}']);
  assert.ok(CLI_TABLE.every(x => x.readyStates.includes('idle') && x.readyStates.includes('done')));
  assert.deepEqual(CLI_TABLE.map(x => x.exit), [{ keys: ['/', 'e', 'x', 'i', 't', 'enter'], maxAttempts: 1 }, { keys: ['ctrl+c'], maxAttempts: 3 }, { keys: ['ctrl+d'], maxAttempts: 1 }]);
});

test('resume IDs follow table templates in native argv and quoted Windows shims', () => {
  for (const row of CLI_TABLE) {
    const command = row.resume.replace('{id}', 'fixture-id');
    assert.equal(resumeSessionId(row, command.split(' ')), 'fixture-id');
    assert.equal(resumeSessionId(row, ['cmd.exe', '/c', `"C:\\Program Files\\npm\\${row.cli}.CMD" ${command.slice(row.cli.length + 1)}`]), 'fixture-id');
    assert.equal(resumeSessionId(row, [command + ' && ' + row.resume.replace('{id}', 'another')]), null);
    assert.equal(resumeSessionId(row, ['sh', '-c', row.cli]), null);
  }
});
test('probes match cwd across Windows, macOS and Linux styles and refuse ambiguity', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ft-probes-')); t.after(() => rm(home, { recursive: true, force: true }));
  async function put(path, value) { const file = join(home, ...path); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, JSON.stringify(value) + '\n'); return file; }
  const claude = await put(['.claude','sessions','12.json'], { pid: 12, cwd: 'C:\\Work\\Project', sessionId: 'claude-id', other: 'ignored' });
  await put(['.claude','sessions','secret.key'], {});
  assert.deepEqual(await probeClaude({ home, cwd: 'c:/work/project', startedAfterMs: 0 }), { sessionId: 'claude-id', source: claude });
  const codex = await put(['.codex','sessions','2026','11','04','rollout-foo-codex-id.jsonl'], { type: 'session_meta', payload: { cwd: '/Users/a/project', session_id: 'codex-id' } });
  assert.deepEqual(await probeCodex({ home, cwd: '/Users/a/project', startedAfterMs: 0 }), { sessionId: 'codex-id', source: codex });
  const pi = await put(['.pi','agent','sessions','encoded','timestamp_pi-id.jsonl'], { type: 'session', cwd: '/home/a/project', id: 'pi-id' });
  assert.deepEqual(await probePi({ home, cwd: '/home/a/project', startedAfterMs: 0 }), { sessionId: 'pi-id', source: pi });
  assert.equal(await probePi({ home, cwd: '/home/a/other', startedAfterMs: 0 }), null);
  assert.equal(await probeClaude({ home, cwd: 'C:/Work/Project', startedAfterMs: Date.now() + 10000 }), null);
  await put(['.claude','sessions','13.json'], { pid: 13, cwd: 'C:/work/project', sessionId: 'another' });
  assert.equal((await probeClaude({ home, cwd: 'C:/work/project' })).reason, 'ambiguous');
});
test('hc endpoint follows platform defaults, session and overrides', () => {
  assert.equal(hcEndpoint({ USERNAME: 'A User', HC_SESSION: 'test' }, 'win32').path, '\\\\.\\pipe\\herdr-core-AUser-test.sock');
  assert.equal(hcEndpoint({ HOME: '/Users/a' }, 'darwin', () => false).path.replaceAll('\\', '/'), '/Users/a/.local/state/herdr-core/default/default.sock');
  assert.equal(hcEndpoint({ HOME: '/home/a', XDG_RUNTIME_DIR: '/run/me', HC_SESSION: 'work' }, 'linux').path.replaceAll('\\', '/'), '/run/me/herdr-core/work.sock');
  assert.equal(hcEndpoint({ HC_TERMINAL_SOCKET: 'first', HC_SOCKET: 'second' }).path, 'first');
  assert.throws(() => hcEndpoint({ HC_SESSION: '../bad' }));
});
