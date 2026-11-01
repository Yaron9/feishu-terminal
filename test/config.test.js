import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { acquireLock } from '../src/instance-lock.js';

test('config fails closed for missing credentials, empty/multiple chats, invalid ACLs/cwd and embedded secrets', async t => {
  const dir = await mkdtemp(new URL('../.test-config-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const base = { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: '/tmp' };
  const env = { FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'secret-fixture', FEISHU_TERMINAL_CONFIG: file };
  await assert.rejects(loadConfig({}));
  for (const invalid of [{ chatIds: [] }, { chatIds: ['oc_a', 'oc_b'] }, { operatorOpenIds: [] }, { defaultCwd: 'relative' }, { appSecret: 'embedded' }]) {
    await writeFile(file, JSON.stringify({ ...base, ...invalid })); await assert.rejects(loadConfig(env));
  }
  await writeFile(file, JSON.stringify(base));
  const config = await loadConfig(env);
  assert.deepEqual(config.chatIds, base.chatIds); assert.ok(!JSON.stringify(config).includes('secret-fixture'));
});

test('instance lock refuses a live owner, releases cleanly, recovers a terminated PID and fails closed on corruption', async t => {
  const dir = await mkdtemp(new URL('../.test-lock-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'bridge.lock');
  const release = await acquireLock(file);
  await assert.rejects(acquireLock(file), /Another instance/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
  await release();
  // Use an actual exited child PID rather than assuming a random PID is dead.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  await writeFile(file, String(child.pid));
  const recovered = await acquireLock(file); await recovered();
  await writeFile(file, 'corrupt'); await assert.rejects(acquireLock(file), /Invalid instance lock/);
});
