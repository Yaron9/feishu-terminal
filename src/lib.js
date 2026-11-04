import { Bridge } from './bridge.js';
import { Store } from './store.js';
import { bridgeTransport } from './transport.js';
import { normalizeEvent } from './events.js';
export { createConfigRegistry } from './registry.js';
export { createBackends } from './backends/index.js';

/**
 * Create a connection-free bridge. backends is the existing backend facade
 * (list/get/read/sendText/sendKeys/close/create/identity/processOf/status/subscribe/dispose).
 * clock is a millisecond function; log receives sanitized diagnostic strings.
 * Store and audit paths belong to the caller. No environment or config file is loaded.
 * @param {{config: Object, transport: import('./transport.js').Transport,
 * registry: import('./registry.js').GroupRegistry, backends: Object,
 * storeFile: string, auditFile: string, log?: Function, clock?: Function}} options
 * @returns {{start: Function, handle: (rawEvent: Object) => Promise<boolean>, stop: Function, accept: Function}}
 */
export function createBridge({ config, transport, registry, backends, storeFile, auditFile, log = () => {}, clock = Date.now }) {
  if (!storeFile || !auditFile || !backends || !registry) throw new TypeError('storeFile, auditFile, backends and registry are required');
  const edge = bridgeTransport(transport);
  let core, starting, stopping, stopped = false;
  const dispatch = async (raw, wait) => {
    if (!core || stopped) return false;
    const event = normalizeEvent(raw, transport.botOpenId ?? config.botOpenId);
    if (!event || !registry.get(event.chatId)) return false;
    if (event.kind === 'button' && !core.store.data.cardSchemas?.[event.messageId] &&
        !core.store.actionCard(event.messageId)) return false;
    // Reject before durable deduplication, ACL notices, audit or backend work.
    if (wait) await core.handle(event);
    else await core.accept(event);
    return true; // duplicates and denied operators are still consumed by this bridge
  };
  return {
    start(options) {
      if (stopped) return Promise.reject(new Error('Bridge stopped'));
      return starting ??= (async () => {
        const store = await new Store(storeFile, { now: clock }).load();
        core = new Bridge({ config: { ...config, auditFile }, registry, backend: backends,
          feishu: edge, store, now: clock, onError: log });
        await core.start(options);
      })();
    },
    handle: raw => dispatch(raw, true),
    // Standalone ACK path: wait for durable admission, then execute on core queues.
    accept: raw => dispatch(raw, false),
    stop() {
      stopped = true;
      return stopping ??= (async () => {
        try { await starting; } finally { await core?.stop(); }
      })();
    },
  };
}
