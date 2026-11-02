// Memory-only traffic fixture: no platform traffic or disk fsync workload.
// Optional --expose-gc reports retained heap after GC separately from idle RSS.
import { Feishu } from '../src/feishu.js';
import { Store } from '../src/store.js';
import { encodeFrame, decodeFrame } from '../src/feishu-frame.js';
import { getHeapSpaceStatistics } from 'node:v8';
import { setTimeout as delay } from 'node:timers/promises';

let delivered = 0, acks = 0;
const edge = new Feishu({ appId: 'fixture', appSecret: 'fixture' });
edge.ws.start = async () => {};
edge.ws.sendMessage = () => { acks++; };
await edge.start(() => { delivered++; });
edge.ws.eventDispatcher = edge.dispatcher;
const store = new Store('memory-only'); store.write = async () => {};
const samples = [];
try {
  for (let batch = 0; batch < 400; batch++) {
    for (let j = 0; j < 250; j++) {
      const id = `event-${batch * 250 + j}`;
      await edge.ws.handleEventData(decodeFrame(encodeFrame({ SeqID: BigInt(batch), LogID: 18446744073709551615n, service: 7, method: 1,
        headers: Object.entries({ type: 'event', sum: '1', seq: '0', message_id: id }).map(([key, value]) => ({ key, value })),
        payload: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: id },
          event: { message: { message_id: id, message_type: 'text', content: '{"text":"fixture"}' } } })),
      })));
    }
    await store.transaction(data => {
      data.cardSchemas ??= {};
      for (let j = 0; j < 250; j++) {
        const id = `card-${batch * 250 + j}`;
        data.cardSchemas[id] = { schemaVersion: '2.0', kind: 'turn', updatedAt: Date.now() };
        data.seen.push(id);
      }
    });
    if ([3, 39, 199, 399].includes(batch)) {
      global.gc?.();
      samples.push({ events: delivered, acks, ...process.memoryUsage(), fragments: edge.ws.dataCache.cache.size,
        fragmentBytes: edge.ws.dataCache.bytes, schemas: Object.keys(store.data.cardSchemas).length, seen: store.data.seen.length,
        spaces: getHeapSpaceStatistics() });
    }
  }
  // Give V8's concurrent sweeping/unmapping an event-loop turn after the
  // deliberately unpaced burst, then measure the retained idle state too.
  await delay(2000); global.gc?.(); await delay(100);
  samples.push({ phase: 'idle-after-burst', events: delivered, acks, ...process.memoryUsage(),
    fragments: edge.ws.dataCache.cache.size, fragmentBytes: edge.ws.dataCache.bytes,
    schemas: Object.keys(store.data.cardSchemas).length, seen: store.data.seen.length, spaces: getHeapSpaceStatistics() });
  console.log(JSON.stringify({ node: process.version, platform: process.platform, forcedGc: Boolean(global.gc), samples }));
} finally { edge.close(); }
