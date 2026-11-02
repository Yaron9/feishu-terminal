import { HerdrClient } from '../herdr-client.js';
import { HerdrBackend } from './herdr.js';
import { HcBackend } from './hc.js';

// list/get/read/sendText/sendKeys/close/create/subscribe, identity/processOf/status.
// Reads return {read:{text}}; subscribe emits {data:{pane_id,...}}. Mutations
// are never retried. A backend outage must not remove another backend's facts.
export class Backends {
  constructor(backends, { newTerminalBackend = 'hc', onError = () => {} } = {}) {
    this.backends = new Map(backends.map(b => [b.name, b]));
    Object.assign(this, { newTerminalBackend, onError });
  }
  backend(id) {
    const name = id.startsWith('hc:') ? 'hc' : 'herdr';
    const backend = this.backends.get(name);
    if (!backend) throw Object.assign(new Error('Backend unavailable'), { code: 'backend_unavailable' });
    return backend;
  }
  async list() {
    const results = await Promise.allSettled([...this.backends.values()].map(async b => {
      try { return await b.list(); }
      catch (error) { this.reportError(b, error); throw error; }
    }));
    return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  }
  get(id, options) { return this.backend(id).get(id, options); }
  reportError(backend, error) {
    this.onError(`backend_unreachable ${backend.name} ` + JSON.stringify({ code: error.code ?? 'unknown', message: error.message }));
  }
  read(id, options) { return this.backend(id).read(id, options); }
  sendText(id, text, options) { return this.backend(id).sendText(id, text, options); }
  sendKeys(id, keys) { return this.backend(id).sendKeys(id, keys); }
  close(id) { return this.backend(id).close(id); }
  create(cmd, cwd) {
    const backend = this.backends.get(this.newTerminalBackend);
    if (!backend) throw Object.assign(new Error('Creation backend unavailable'), { code: 'backend_unavailable' });
    return backend.create(cmd, cwd);
  }
  identity(t) { return this.backend(t.pane_id).identity(t); }
  processOf(t) { return this.backend(t.pane_id).processOf(t); }
  status(t, screen) { return this.backend(t.pane_id).status(t, screen); }
  subscribe(ids, onEvent, onState = () => {}) {
    const stops = [];
    for (const b of this.backends.values()) {
      const selected = ids.filter(id => this.backend(id) === b);
      if (!selected.length) continue;
      try { stops.push(b.subscribe(selected, onEvent, state => onState(state, selected))); }
      catch (error) { this.reportError(b, error); }
    }
    return () => stops.forEach(stop => stop());
  }
  dispose() { for (const b of this.backends.values()) b.dispose(); }
}

export function createBackends(config, options = {}) {
  return new Backends(config.backends.map(name => name === 'hc' ? new HcBackend() : new HerdrBackend(new HerdrClient())),
    { newTerminalBackend: config.newTerminalBackend, ...options });
}

// Compatibility for callers injecting the pre-ft25 client (including selftest).
export function bridgeBackend(backend, legacyClient, onError) {
  return backend ?? new Backends([new HerdrBackend(legacyClient)], { newTerminalBackend: 'herdr', onError });
}
