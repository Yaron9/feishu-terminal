import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runtimePaths } from '../src/runtime.js';

test('npm start entrypoint can print help without a cwd dotenv file', async t => {
  const dir = await mkdtemp(new URL('../.test-runtime-', import.meta.url)); t.after(() => rm(dir, { recursive: true, force: true }));
  const { fileURLToPath } = await import('node:url');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const args = pkg.scripts.start.split(' ').slice(1).map(arg => arg === 'bin/feishu-terminal.js' ? fileURLToPath(new URL('../bin/feishu-terminal.js', import.meta.url)) : arg);
  const result = await promisify(execFile)(process.execPath, [...args, '--help'], { cwd: dir, windowsHide: true });
  assert.match(result.stdout, /feishu-terminal \[setup/);
});

test('runtime ignores cwd config and selects only the installed layout or explicit config and sibling dotenv', async t => {
  const dir = await mkdtemp(new URL('../.test-runtime-', import.meta.url)); t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = runtimePaths({}, dir);
  assert.equal(paths.configFile, join(homedir(), '.config/feishu-terminal/config.json'));
  await writeFile(join(dir, 'config.json'), '{}');
  assert.equal(runtimePaths({}, dir).configFile, paths.configFile);
  const explicit = runtimePaths({ FEISHU_TERMINAL_CONFIG: join(dir, 'custom.json') }, dir);
  assert.equal(explicit.configFile, join(dir, 'custom.json'));
  assert.equal(explicit.envFile, join(dir, '.env'));
  assert.equal(runtimePaths({ FEISHU_TERMINAL_CONFIG: join(dir, 'custom.json'), STATE: dir }, dir).stateDir, dir);
});

test('installed command loads config sibling dotenv, preserves caller variables and pins the selected config', async t => {
  const dir = await mkdtemp(new URL('../.test-runtime-', import.meta.url)); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '.env'), 'FEISHU_APP_ID=file_value\nFEISHU_APP_SECRET=fixture_only\nFEISHU_TERMINAL_CONFIG=./wrong.json\n');
  const configFile = join(dir, 'config.json');
  const source = `import { prepareEnvironment } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
    const paths = prepareEnvironment();
    console.log(JSON.stringify({ id: process.env.FEISHU_APP_ID, loaded: process.env.FEISHU_APP_SECRET === 'fixture_only', config: paths.configFile }));`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    env: { FEISHU_TERMINAL_CONFIG: configFile, FEISHU_APP_ID: 'caller_wins', SystemRoot: process.env.SystemRoot || '' }, windowsHide: true,
  });
  assert.deepEqual(JSON.parse(result.stdout), { id: 'caller_wins', loaded: true, config: configFile });
});

test('selftest CLI returns 1 on invalid configuration before any live API or socket use', async t => {
  const dir = await mkdtemp(new URL('../.test-runtime-', import.meta.url)); t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = new URL('../bin/feishu-terminal.js', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(cli), 'selftest', '--herdr-socket', '/not-used.sock'], {
    env: { FEISHU_TERMINAL_CONFIG: join(dir, 'missing.json'), FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture_secret',
      SystemRoot: process.env.SystemRoot || '' }, windowsHide: true,
  }), error => error.code === 1 && error.stderr.includes('startup_failed') &&
    error.stderr.includes(`CONFIG ${join(dir, 'missing.json')}`) && !error.stderr.includes('fixture_secret'));
});
