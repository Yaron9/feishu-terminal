#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { HerdrClient } from '../src/herdr-client.js';
import { Feishu } from '../src/feishu.js';
import { Bridge } from '../src/bridge.js';
import { acquireLock } from '../src/instance-lock.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { prepareEnvironment } from '../src/runtime.js';

let bridge, releaseLock, commandAbort;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') {
    console.log('feishu-terminal [setup [--new-group] [--operator ou_xxx] | selftest --herdr-socket <path>]'); return;
  }
  if (command === 'setup') {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--new-group') options.newGroup = true;
      else if (args[i] === '--operator' && /^ou_[A-Za-z0-9]+$/.test(args[i + 1] ?? '')) options.operator = args[++i];
      else throw new Error('Invalid setup option');
    }
    const paths = prepareEnvironment();
    const { setup } = await import('../src/setup.js');
    commandAbort = new AbortController();
    process.exitCode = await setup({ paths, ...options, signal: commandAbort.signal }); return;
  }
  if (command === 'selftest') {
    if (args.length && (args.length !== 2 || args[0] !== '--herdr-socket' || !args[1] || args[1].startsWith('--'))) throw new Error('Invalid selftest option');
    if (!args.length && !process.env.HERDR_TCP) throw new Error('Explicit selftest endpoint required');
    prepareEnvironment();
    const { selftest } = await import('../src/selftest.js');
    commandAbort = new AbortController();
    process.exitCode = await selftest({ config: await loadConfig(), socket: args[1], signal: commandAbort.signal }); return;
  }
  if (command) throw new Error('Unknown subcommand');
  prepareEnvironment();
  const config = await loadConfig();
  const lockFile = config.stateFile + '.lock';
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  releaseLock = await acquireLock(lockFile);
  const store = await new Store(config.stateFile).load();
  bridge = new Bridge({ herdr: new HerdrClient(), feishu: new Feishu({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET }),
    store, config, onError: code => console.error(code) });
  await bridge.start();
  console.log('feishu-terminal running');
}
let stopping = false;
async function stop(exitCode) {
  if (stopping) return; stopping = true;
  if (commandAbort) { commandAbort.abort(); process.exitCode = exitCode; return; }
  const deadline = setTimeout(() => process.exit(exitCode), 15000); deadline.unref();
  try { await bridge?.stop(); }
  finally {
    if (releaseLock) await releaseLock();
    process.exitCode = exitCode;
  }
}
process.once('SIGINT', () => { stop(0).catch(() => process.exit(1)); });
process.once('SIGTERM', () => { stop(0).catch(() => process.exit(1)); });
main().catch(() => {
  console.error('startup_failed: check command options, env, configuration, state permissions and instance lock');
  stop(1).catch(() => process.exit(1));
});
