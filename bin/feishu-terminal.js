#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { HerdrClient } from '../src/herdr-client.js';
import { Feishu } from '../src/feishu.js';
import { Bridge } from '../src/bridge.js';
import { acquireLock } from '../src/instance-lock.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

let bridge, releaseLock;
async function main() {
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
  console.error('startup_failed: check env, configuration, state permissions and instance lock');
  stop(1).catch(() => process.exit(1));
});
