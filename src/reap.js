import { CLI_TABLE, lookupCli } from './cli-table.js';
import { detectMenu } from './menus.js';

const missing = error => ['not_found', 'pane_not_found'].includes(error.code);
const local = id => /^hc:t[a-zA-Z0-9]+$/.test(id);

export class Reap {
  constructor(bridge, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), waitMs = 1000 } = {}) {
    const idleMinutes = bridge.config.idleMinutes === undefined ? 10 : bridge.config.idleMinutes;
    if (typeof idleMinutes !== 'number' || !Number.isFinite(idleMinutes) || idleMinutes <= 0)
      throw new TypeError('idleMinutes must be a positive finite number');
    Object.assign(this, { bridge, sleep, waitMs, idleMs: idleMinutes * 60000 });
    this.ready = new Map();
  }
  input(topicId) {
    const binding = this.bridge.store.list().find(b => b.topicId === topicId);
    if (binding) this.ready.delete(binding.paneId);
  }
  fingerprint(terminal) {
    return JSON.stringify([terminal.terminal_id, terminal.foreground?.pid ?? terminal.pid,
      terminal.turn, terminal.status_ms, terminal.status?.state, lookupCli(terminal)?.cli,
      this.bridge.store.forPane(terminal.pane_id)?.generation]);
  }
  pending(binding) {
    const b = this.bridge;
    return binding && (binding.frozen || binding.dormant || binding.wakePending || binding.needs_check ||
      binding.queuedInputs?.length || b.pendingInputs.has(binding.topicId) ||
      (binding.sessionHandoff && !binding.sessionHandoff.done));
  }
  eligible(terminal) {
    const b = this.bridge, row = lookupCli(terminal), binding = b.store.forPane(terminal.pane_id);
    if (!local(terminal.pane_id) || terminal.state !== 'live' || terminal.waiting_for_person || terminal.labels?.['ft.woken'] !== '1' ||
      Object.keys(terminal.labels ?? {}).some(key => key.startsWith('herdr.')) ||
      !row?.readyStates.includes(terminal.status?.state) || this.pending(binding)) return false;
    // A different host/bridge's label alone does not establish our ownership.
    if (binding) return Boolean(b.registry.get(binding.chatId) && b.identitiesMatch(binding, terminal));
    return b.store.data.createdTerminals?.includes(terminal.terminal_id) ?? false;
  }
  async tick() {
    const b = this.bridge, hc = b.backend.backends?.get('hc');
    if (b.stopped || !hc?.inspect || !hc.remove) return;
    let terminals;
    try { terminals = await hc.list(); }
    catch (error) { this.ready.clear(); b.backend.reportError(hc, error); return; }
    const live = new Set(terminals.map(t => t.pane_id));
    for (const id of this.ready.keys()) if (!live.has(id)) this.ready.delete(id);
    for (const record of b.store.data.reaps ?? []) await this.schedule(record.paneId, () => this.finish(record, hc));
    for (const terminal of terminals) {
      if (!this.eligible(terminal)) { this.ready.delete(terminal.pane_id); continue; }
      const fingerprint = this.fingerprint(terminal), previous = this.ready.get(terminal.pane_id);
      if (!previous || previous.fingerprint !== fingerprint) {
        this.ready.set(terminal.pane_id, { fingerprint, since: b.now() }); continue;
      }
      if (b.now() - previous.since < this.idleMs || b.store.data.reaps?.some(r => r.paneId === terminal.pane_id)) continue;
      await this.schedule(terminal.pane_id, async () => {
        const fresh = await hc.inspect(terminal.pane_id);
        if (!this.eligible(fresh) || this.fingerprint(fresh) !== fingerprint) { this.ready.delete(terminal.pane_id); return; }
        const { read } = await hc.read(terminal.pane_id, { source: 'visible' });
        if (detectMenu(read.text).kind) { this.ready.delete(terminal.pane_id); return; }
        const record = { paneId: terminal.pane_id, terminalId: terminal.terminal_id,
          cli: lookupCli(fresh).cli, fingerprint, attempts: 0, phase: 'waiting' };
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
    return task.catch(() => b.onError('reap_failed'));
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
    for (;;) {
      let terminal;
      try { terminal = await hc.inspect(record.paneId); }
      catch (error) { if (missing(error)) { await this.complete(record); return; } throw error; }
      if (terminal.terminal_id !== record.terminalId) { await this.forget(record); return; }
      if (terminal.labels?.['ft.woken'] !== '1' || Object.keys(terminal.labels).some(key => key.startsWith('herdr.'))) {
        await this.forget(record); return;
      }
      const binding = b.store.forPane(record.paneId);
      if (terminal.waiting_for_person) return;
      if (binding && (!b.registry.get(binding.chatId) || b.pendingInputs.has(binding.topicId) ||
        binding.queuedInputs?.length || binding.needs_check || binding.wakePending)) return;
      if (terminal.state === 'finished') {
        // hc itself refuses rm of a live terminal; an ambiguous rm can safely
        // be reconciled by inspecting the same identity on the next tick.
        await hc.remove(record.paneId); await this.complete(record); return;
      }
      if (!this.eligible(terminal) || this.fingerprint(terminal) !== record.fingerprint) { await this.forget(record); return; }
      if (record.phase === 'signalling' || record.attempts >= row.exit.maxAttempts) return;
      const { read } = await hc.read(record.paneId, { source: 'visible' });
      if (detectMenu(read.text).kind) { await this.forget(record); return; }
      record = { ...record, attempts: record.attempts + 1, phase: 'signalling' };
      await this.save(record); // Claim before keys: never replay an uncertain exit.
      const fresh = await hc.inspect(record.paneId);
      if (!this.eligible(fresh) || this.fingerprint(fresh) !== record.fingerprint) { await this.forget(record); return; }
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
    if (binding?.identity?.terminalId === record.terminalId && b.registry.get(binding.chatId)) await b.wake.dormant(binding);
    await this.forget(record);
  }
}
