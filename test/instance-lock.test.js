import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, readFile, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from '../src/instance-lock.js';

async function fixture(t) {
  const dir = await mkdtemp(new URL('../.test-recovery-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true })); return join(dir, 'bridge.lock');
}
function child(t, source, file) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], {
    env: { ...globalThis.process.env, FT_LOCK_TEST_FILE: file }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(async () => { if (process.exitCode === null && process.signalCode === null) { const ended = once(process, 'exit'); process.kill('SIGKILL'); await ended; } });
  return process;
}

test('lock recovers after a recovery guard holder is killed', async t => {
  const file = await fixture(t);
  // Reproduce the old mkdir -> read/unlink critical section, then kill its
  // holder. No graceful cleanup is allowed to hide the abandoned guard.
  const holder = child(t, `
    import {mkdir,writeFile} from 'node:fs/promises';
    const file=process.env.FT_LOCK_TEST_FILE;
    await mkdir(file+'.recovery');
    await writeFile(file+'.recovery/owner.json',JSON.stringify({pid:process.pid,startTime:'fixture-start',token:'killed-guard'}));
    process.send('recovering'); setInterval(()=>{},1000);
  `, file);
  assert.deepEqual(await once(holder, 'message'), ['recovering', undefined]);
  await writeFile(file, String(holder.pid));
  const ended = once(holder, 'exit'); holder.kill('SIGKILL'); await ended;
  const release = await acquireLock(file);
  await assert.rejects(acquireLock(file), /Another instance/);
  await release();
});

test('competing processes recover one dead lock with exactly one live owner', async t => {
  const file = await fixture(t);
  const dead = child(t, `process.exit(0)`, file); await once(dead, 'exit'); await writeFile(file, String(dead.pid));
  const source = `
    import {acquireLock} from ${JSON.stringify(new URL('../src/instance-lock.js', import.meta.url).href)};
    try { const release=await acquireLock(process.env.FT_LOCK_TEST_FILE); process.send('acquired');
      process.on('message',async()=>{await release();process.exit(0)});
    } catch {process.send('refused');process.exit(0)}
  `;
  const contenders = Array.from({ length: 4 }, () => child(t, source, file));
  const results = await Promise.all(contenders.map(p => once(p, 'message').then(([message]) => message)));
  assert.equal(results.filter(r => r === 'acquired').length, 1);
  const winner = contenders[results.indexOf('acquired')]; const ended = once(winner, 'exit'); winner.send('release'); await ended;
  const release = await acquireLock(file); await release();
});

test('lock records process start time and distinguishes a reused PID', async t => {
  const file = await fixture(t); const release = await acquireLock(file);
  const owner = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(owner.pid, process.pid); assert.equal(typeof owner.startTime, 'string'); assert.ok(owner.startTime);
  await release();
  await writeFile(file, JSON.stringify({ ...owner, startTime: 'older-process-with-same-pid' }));
  const recovered = await acquireLock(file); await recovered();
});

test('recovery bypasses an aged legacy empty guard but never an aged live guard', async t => {
  const file = await fixture(t); const release = await acquireLock(file);
  const owner = JSON.parse(await readFile(file, 'utf8')); await release();
  await writeFile(file, JSON.stringify({ ...owner, startTime: 'old-process' }));
  const guard = file + '.recovery'; await mkdir(guard);
  const old = new Date(Date.now() - 60000); await utimes(guard, old, old);
  const recovered = await acquireLock(file); await recovered();
  await writeFile(file, JSON.stringify({ ...owner, startTime: 'old-process' }));
  await writeFile(guard, JSON.stringify(owner)); await utimes(guard, old, old);
  await assert.rejects(acquireLock(file), /Another instance is recovering/);
});
