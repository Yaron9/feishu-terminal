// Offline, reproducible idle bridge: real Feishu clients, fixture herdr socket,
// no credentials, platform traffic, V8 flags or forced GC in RSS comparisons.
import { Feishu } from '../src/feishu.js';
import { harness } from '../test/helpers.js';
import { getHeapStatistics, getHeapSpaceStatistics } from 'node:v8';
import { setTimeout as delay } from 'node:timers/promises';

const cleanup = [];
const feishu = new Feishu({ appId: 'cli_0123456789abcdef', appSecret: 'fixture' });
feishu.ws.start = async () => {}; // Keep real client allocations; isolate network.
const h = await harness({ after(fn) { cleanup.push(fn); } }, { feishu });
try {
  const samples = [];
  for (let i = 0; i < 6; i++) {
    await delay(1000);
    await h.bridge.tick();
    samples.push(process.memoryUsage());
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform,
    samples, heap: getHeapStatistics(), spaces: getHeapSpaceStatistics() }));
} finally { for (const fn of cleanup.reverse()) await fn(); }
