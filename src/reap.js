import { CLI_TABLE, lookupCli } from './cli-table.js';
import { detectMenu } from './menus.js';

const missing = error => ['not_found', 'pane_not_found'].includes(error.code);
const local = id => /^hc:t[a-zA-Z0-9]+$/.test(id);

export class Reap {
  constructor(bridge, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), waitMs = 1000, reapCreated = true } = {}) {
    const idleMinutes = bridge.config.idleMinutes === undefined ? 10 : bridge.config.idleMinutes;
    if (typeof idleMinutes !== 'number' || !Number.isFinite(idleMinutes) || idleMinutes <= 0)
      throw new TypeError('idleMinutes must be a positive finite number');
    Object.assign(this, { bridge, sleep, waitMs, reapCreated, idleMs: idleMinutes * 60000 });
    this.ready = new Map();
  }
  input(topicId) {
    const binding = this.bridge.store.list().find(b => b.topicId === topicId);
    if (binding) this.ready.delete(binding.paneId);
  }
  fingerprint(terminal) {
    return JSON.stringify([terminal.terminal_id, terminal.foreground?.pid ?? terminal.pid,
      terminal.turn, terminal.status_ms, terminal.status?.state, lookupCli(terminal)?.cli,
      this.bridge.store.forPane(terminal.pane_id)?.generation, this.bridge.tree.parentId(terminal)]);
  }
  pending(binding) {
    const b = this.bridge;
    return binding && (binding.frozen || binding.dormant || binding.wakePending || binding.needs_check ||
      binding.queuedInputs?.length || b.pendingInputs.has(binding.topicId) ||
      (binding.sessionHandoff && !binding.sessionHandoff.done));
  }
  screenVeto(terminal, text) {
    return Boolean(detectMenu(text).kind || lookupCli(terminal)?.backgroundScreen?.test(text));
  }
  owned(terminal) {
    return terminal.labels?.['ft.woken'] === '1' ||
      (this.reapCreated && this.bridge.store.data.createdTerminals?.includes(terminal.terminal_id));
  }
  idle(terminal) {
    const b = this.bridge, row = lookupCli(terminal), binding = b.store.forPane(terminal.pane_id);
    return local(terminal.pane_id) && terminal.state === 'live' && !terminal.waiting_for_person &&
      !Object.keys(terminal.labels ?? {}).some(key => key.startsWith('herdr.')) &&
      Boolean(row?.readyStates.includes(terminal.status?.state)) && !this.pending(binding) &&
      !binding?.turn?.background?.running?.length &&
      (!binding || Boolean(b.registry.get(binding.chatId) && b.identitiesMatch(binding, terminal)));
  }
  eligible(terminal) {
    const b = this.bridge, binding = b.store.forPane(terminal.pane_id);
    if (!this.idle(terminal) || !this.owned(terminal)) return false;
    // A different host/bridge's label alone does not establish our ownership.
    if (binding) return Boolean(b.registry.get(binding.chatId) && b.identitiesMatch(binding, terminal));
    return b.store.data.createdTerminals?.includes(terminal.terminal_id) ?? false;
  }
  children(terminal, terminals) {
    const found = new Set([terminal.pane_id]), children = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const child of terminals) {
        if (child.state !== 'live' || found.has(child.pane_id)) continue;
        const binding = this.bridge.store.forPane(child.pane_id);
        const savedParent = binding?.tree && this.bridge.identitiesMatch(binding, child) ? this.bridge.tree.parent(binding)?.paneId : null;
        if (!found.has(this.bridge.tree.parentId(child)) && !found.has(savedParent)) continue;
        found.add(child.pane_id); children.push(child); changed = true;
      }
    }
    return children;
  }
  settled(terminal) {
    const ready = this.ready.get(terminal.pane_id);
    return this.idle(terminal) && ready?.fingerprint === this.fingerprint(terminal) && this.bridge.now() - ready.since >= this.idleMs;
  }
  familySettled(terminal, terminals) {
    return this.children(terminal, terminals).every(child => this.settled(child));
  }
  async familyReady(terminal, hc) {
    // Include unbound native descendants and saved links for children resumed
    // before their parent. They need not be independently reap-owned.
    const before = this.children(terminal, await hc.list());
    for (const child of before) {
      if (!this.settled(child)) return false;
      const fresh = await hc.inspect(child.pane_id);
      if (!this.settled(fresh)) { this.ready.delete(child.pane_id); return false; }
      const { read } = await hc.read(child.pane_id, { source: 'visible' });
      if (this.screenVeto(fresh, read.text)) { this.ready.delete(child.pane_id); return false; }
    }
    // Catch a new child, a changed status or admitted input while reads awaited.
    const terminals = await hc.list(), current = terminals.find(item => item.pane_id === terminal.pane_id);
    const after = this.children(terminal, terminals);
    const signature = children => JSON.stringify(children.map(child => [child.pane_id, this.fingerprint(child)]).sort());
    return current && this.eligible(current) && this.fingerprint(current) === this.fingerprint(terminal) &&
      signature(before) === signature(after) && after.every(child => this.settled(child));
  }
  async tick() {
    const b = this.bridge, hc = b.backend.backends?.get('hc');
    if (b.stopped || !hc?.inspect || !hc.remove) return;
    let terminals;
    try { terminals = await hc.list(); }
    catch (error) { this.ready.clear(); b.backend.reportError(hc, error); return; }
    const live = new Set(terminals.map(t => t.pane_id));
    for (const id of this.ready.keys()) if (!live.has(id)) this.ready.delete(id);
    for (const terminal of terminals) {
      if (!this.idle(terminal)) { this.ready.delete(terminal.pane_id); continue; }
      const fingerprint = this.fingerprint(terminal), previous = this.ready.get(terminal.pane_id);
      if (!previous || previous.fingerprint !== fingerprint) {
        this.ready.set(terminal.pane_id, { fingerprint, since: b.now() });
      }
    }
    for (const record of b.store.data.reaps ?? []) await this.schedule(record.paneId, () => this.finish(record, hc));
    for (const terminal of terminals) {
      if (!this.eligible(terminal) || !this.familySettled(terminal, terminals)) continue;
      const fingerprint = this.fingerprint(terminal), previous = this.ready.get(terminal.pane_id);
      if (!previous) continue;
      if (b.now() - previous.since < this.idleMs || b.store.data.reaps?.some(r => r.paneId === terminal.pane_id)) continue;
      await this.schedule(terminal.pane_id, async () => {
        const fresh = await hc.inspect(terminal.pane_id);
        if (!this.eligible(fresh) || this.fingerprint(fresh) !== fingerprint) { this.ready.delete(terminal.pane_id); return; }
        const { read } = await hc.read(terminal.pane_id, { source: 'visible' });
        if (this.screenVeto(fresh, read.text)) { this.ready.delete(terminal.pane_id); return; }
        const binding = b.store.forPane(terminal.pane_id);
        const record = { paneId: terminal.pane_id, terminalId: terminal.terminal_id,
          cli: lookupCli(fresh).cli, sessionId: binding?.sessionId, sessionSource: binding?.sessionSource,
          cwd: binding?.cwd, fingerprint, attempts: 0, phase: 'waiting' };
        await b.store.transaction(data => { (data.reaps ??= []).push(record); });
        await this.finish(record, hc);
      });
    }
  }
  schedule(paneId, operation) {
    const b = this.bridge, binding = b.store.forPane(paneId);
    const run = () => b.enqueue(operation, `reap:${paneId}`);
    // Drain input/output/card work before checking eligibility, and keep new
    // input queued while an exit is being confirmed. Admission stays visible.
    const task = binding ? b.enqueue(() => b.enqueue(() => b.enqueue(run,
      `card:${binding.topicId}`), `output:${binding.topicId}`), binding.topicId) : run();
    return task.catch(error => { this.ready.clear(); b.reportFailure('reap_failed', error); });
  }
  save(record) {
    return this.bridge.store.transaction(data => {
      const index = (data.reaps ?? []).findIndex(r => r.terminalId === record.terminalId);
      if (index >= 0) data.reaps[index] = structuredClone(record);
    });
  }
  forget(record) {
    this.ready.delete(record.paneId);
    return this.bridge.store.transaction(data => {
      data.reaps = (data.reaps ?? []).filter(r => r.terminalId !== record.terminalId);
    });
  }
  async finish(record, hc) {
    const b = this.bridge, row = CLI_TABLE.find(row => row.cli === record.cli);
    if (!row || b.stopped) return;
    let closed = false;
    for (;;) {
      let terminal;
      try { terminal = await hc.inspect(record.paneId); }
      catch (error) { if (missing(error)) { await this.complete(record); return; } throw error; }
      if (terminal.terminal_id !== record.terminalId) { await this.forget(record); return; }
      if (!this.owned(terminal) ||
          Object.keys(terminal.labels ?? {}).some(key => key.startsWith('herdr.'))) {
        await this.forget(record); return;
      }
      const binding = b.store.forPane(record.paneId);
      if (binding?.turn?.background?.running?.length) { await this.forget(record); return; }
      if (terminal.waiting_for_person) return;
      if (binding && (!b.registry.get(binding.chatId) || b.pendingInputs.has(binding.topicId) ||
        binding.queuedInputs?.length || binding.needs_check || binding.wakePending)) return;
      if (terminal.state === 'finished') {
        // hc itself refuses rm of a live terminal; an ambiguous rm can safely
        // be reconciled by inspecting the same identity on the next tick.
        await hc.remove(record.paneId); await this.complete(record); return;
      }
      if (record.attempts >= 1 && terminal.state === 'live' && !lookupCli(terminal) &&
          terminal.foreground?.pid != null && terminal.foreground.pid === terminal.pid) {
        if (closed) return;
        await hc.close(record.paneId); closed = true; continue;
      }
      if (!this.eligible(terminal) || this.fingerprint(terminal) !== record.fingerprint) { await this.forget(record); return; }
      if (record.phase === 'signalling' || record.attempts >= row.exit.maxAttempts) return;
      const { read } = await hc.read(record.paneId, { source: 'visible' });
      if (this.screenVeto(terminal, read.text)) { await this.forget(record); return; }
      if (!await this.familyReady(terminal, hc)) { await this.forget(record); return; }
      record = { ...record, attempts: record.attempts + 1, phase: 'signalling' };
      await this.save(record); // Claim before keys: never replay an uncertain exit.
      const fresh = await hc.inspect(record.paneId);
      if (!this.eligible(fresh) || this.fingerprint(fresh) !== record.fingerprint) { await this.forget(record); return; }
      if (!await this.familyReady(fresh, hc) || !this.eligible(fresh)) { await this.forget(record); return; }
      if (b.stopped) return;
      await hc.sendKeys(record.paneId, row.exit.keys);
      record.phase = 'waiting'; await this.save(record);
      const deadline = b.now() + this.waitMs;
      while (!b.stopped && b.now() < deadline) {
        const current = await hc.inspect(record.paneId);
        if (current.terminal_id !== record.terminalId || current.state === 'finished' || !this.eligible(current)) break;
        await this.sleep(Math.min(100, deadline - b.now()));
      }
    }
  }
  async complete(record) {
    const b = this.bridge, binding = b.store.forPane(record.paneId);
    if (binding?.identity?.terminalId === record.terminalId && b.registry.get(binding.chatId)) {
      await b.store.transaction(data => {
        const item = data.bindings.find(x => x.chatId === binding.chatId && x.topicId === binding.topicId);
        if (!b.sameGeneration(binding, item) || item.identity?.terminalId !== record.terminalId) return;
        for (const key of ['cli', 'sessionId', 'sessionSource', 'cwd'])
          if (record[key] !== undefined) item[key] = record[key];
        item.sessionVerified = item.sessionSource === 'verified';
        // Go dormant in the same write: a probe that already read the exited
        // pane (a shell prompt, no CLI) must not overwrite these facts with an
        // unknown CLI and leave the topic unable to wake.
        Object.assign(item, { dormant: true, frozen: false, pendingCard: null, pendingMenuCard: null,
          outputBatch: null, recoveryPending: null });
      });
      await b.wake.dormant(binding);
    }
    await this.forget(record);
  }
}
