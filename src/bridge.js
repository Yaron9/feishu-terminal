import { randomUUID, createHash } from 'node:crypto';
import { route, validKeys } from './router.js';
import { clean, screenCard, screenText, newOutput, splitText } from './render.js';
import { paneSubscriptions } from './herdr-client.js';
import { auditRecord, appendAudit } from './store.js';

export class Bridge {
  constructor({ herdr, feishu, store, config, now = Date.now, audit, onError = () => {} }) {
    Object.assign(this, { herdr, feishu, store, config, now, onError });
    this.audit = audit ?? (record => appendAudit(config.auditFile, record));
    this.queue = Promise.resolve(); this.runtime = new Map(); this.stopped = false;
    this.chatId = config.chatIds[0];
  }
  enqueue(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => this.onError('bridge_operation_failed')); return result;
  }
  state(binding) {
    if (!this.runtime.has(binding.topicId)) this.runtime.set(binding.topicId, {
      status: 'unknown', agent: null, dirty: true, lastRead: -Infinity, lastCard: -Infinity,
      lastChange: this.now(), current: binding.lastTranscript ?? '', previous: binding.lastTranscript ?? '',
      pending: false, settle: false, blockedNotice: false,
    });
    return this.runtime.get(binding.topicId);
  }
  async start({ timers = true } = {}) {
    for (const b of this.store.list()) {
      this.state(b);
      if (b.chatId === this.chatId) await this.verify(b).catch(() => {});
    }
    this.resubscribe();
    await this.feishu.start(event => this.handle(event), this.onError);
    if (timers) this.timer = setInterval(() => { this.tick().catch(() => {}); }, 250);
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.unsubscribe?.();
    this.feishu.close(); await this.queue; this.herdr.close();
  }
  resubscribe() {
    this.unsubscribe?.();
    const panes = this.store.list().filter(b => b.chatId === this.chatId).map(b => b.paneId);
    if (panes.length) this.unsubscribe = this.herdr.subscribe(paneSubscriptions(panes), event => {
      this.enqueue(async () => {
        const data = event.data ?? {};
        const binding = this.store.forPane(data.pane_id ?? data.pane?.pane_id);
        if (!binding || binding.chatId !== this.chatId) return;
        const state = this.state(binding); state.dirty = true;
        if (data.agent_status) this.status(state, data.agent_status, data.agent);
      }).catch(() => {});
    }, connection => {
      for (const state of this.runtime.values()) { state.dirty = true; state.status = 'unknown'; }
      if (connection === 'connected') for (const b of this.store.list()) {
        this.enqueue(() => this.verify(b)).catch(() => {});
      }
    });
  }
  status(state, status, agent = state.agent) {
    if (state.status === 'working' && ['idle', 'done'].includes(status)) state.settle = true;
    if (!['idle', 'done'].includes(status)) state.settle = false;
    if (status === 'blocked' && state.status !== 'blocked') state.blockedNotice = true;
    if (status !== 'blocked') state.blockedNotice = false;
    state.status = status; state.agent = agent;
  }
  handle(event) { return this.enqueue(() => this.receive(event)); }
  async refuse(event) {
    if (event.chatId && event.openId && await this.store.claim([`refusal:${event.chatId}:${event.openId}`])) {
      if (event.topicId && event.kind === 'message') await this.feishu.reply(event.topicId, 'Access denied.');
      else await this.feishu.send(event.chatId, 'Access denied.');
    }
  }
  async receive(event) {
    if (this.stopped) return;
    if (event.kind === 'message' && event.senderType !== 'user') return; // never loop on bot output
    if (event.chatId !== this.chatId || !this.config.operatorOpenIds.includes(event.openId)) {
      await this.refuse(event); return;
    }
    const ids = [event.eventId && `event:${event.eventId}`];
    if (event.kind === 'message') ids.push(event.messageId && `message:${event.messageId}`);
    else ids.push(event.callbackToken && `callback:${event.callbackToken}`);
    if (!await this.store.claim(ids)) return;
    const binding = this.store.binding(event.chatId, event.topicId);
    try {
      if (event.kind === 'button') { await this.button(event, binding); return; }
      const action = route(event.text, Boolean(binding));
      await this.log(event, binding, action.type, event.text ?? '');
      if (action.type === 'error') { await this.feishu.reply(event.topicId, action.message); return; }
      if (action.type === 'list') { await this.list(event); return; }
      if (action.type === 'open') { await this.open(event, action.paneId); return; }
      if (action.type === 'create') {
        if (event.isReply) { await this.feishu.reply(event.topicId, 'This topic is not bound. Use /t open <pane_id> in the group.'); return; }
        const pane = await this.createPane();
        const identity = await this.identity(pane.pane_id);
        await this.store.bind({ chatId: event.chatId, topicId: event.messageId, paneId: pane.pane_id, identity });
        this.resubscribe();
        const created = this.store.binding(event.chatId, event.messageId);
        await this.log(event, created, 'first_input', action.text);
        await this.input(created, action.text);
        return;
      }
      if (action.type === 'close') {
        if (action.kill) { await this.verify(binding); await this.herdr.request('pane.close', { pane_id: binding.paneId }); }
        await this.store.unbind(binding.chatId, binding.topicId); this.runtime.delete(binding.topicId); this.resubscribe();
        await this.feishu.reply(binding.topicId, action.kill ? 'Pane closed; topic unbound.' : 'Topic unbound; pane is still running.');
        return;
      }
      if (action.type === 'screen') { this.state(binding).dirty = true; await this.refresh(binding, true); return; }
      if (action.type === 'ok') {
        await this.verify(binding);
        await this.store.update(binding.chatId, binding.topicId, { needs_check: false });
        await this.feishu.reply(binding.topicId, 'Screen acknowledged; input enabled.'); return;
      }
      if (action.type === 'keys') await this.writeInput(binding, 'pane.send_keys', { keys: action.keys }, action.keys.length === 1 && action.keys[0] === 'ctrl+u');
      if (action.type === 'raw') await this.writeInput(binding, 'pane.send_text', { text: action.text });
      if (action.type === 'input') await this.input(binding, action.text);
      this.state(binding).dirty = true;
    } catch (error) {
      if (error.code === 'binding_unverified') {
        await this.feishu.reply(event.topicId, 'Binding frozen: pane identity could not be confirmed. Use /t open <pane> to rebind or /t close.'); return;
      }
      if (this.store.binding(event.chatId, event.topicId)?.needs_check) {
        let screen = '[screen unavailable; use /t screen]';
        try { screen = screenText((await this.herdr.request('pane.read', { pane_id: binding.paneId, source: 'visible', lines: 40 })).read.text); } catch {}
        await this.feishu.reply(event.topicId, `Input needs checking; input was not retried. Inspect the screen, optionally /t k ctrl+u, then /t ok before more input.\n${screen}`); return;
      }
      // Never echo upstream error messages: they may contain terminal content.
      const code = /^[a-z_0-9]+$/i.test(String(error.code)) ? String(error.code) : 'operation_failed';
      await this.feishu.reply(event.topicId, `Request failed (${code}); input was not retried. Use /t screen or /t ls to inspect.`);
    }
  }
  log(event, binding, action, text = '') {
    return this.audit(auditRecord({ openId: event.openId, topicId: binding?.topicId ?? event.topicId, paneId: binding?.paneId, action, text }));
  }
  async identity(paneId) {
    const [{ pane }, { workspaces }] = await Promise.all([
      this.herdr.request('pane.get', { pane_id: paneId }), this.herdr.request('workspace.list'),
    ]);
    if (pane?.pane_id !== paneId || !pane.terminal_id || !pane.tab_id ||
      !workspaces.some(w => w.workspace_id === pane.workspace_id && w.label === 'feishu')) throw new Error('Unconfirmed pane identity');
    return { terminalId: pane.terminal_id, workspaceId: pane.workspace_id, tabId: pane.tab_id };
  }
  async verify(binding) {
    binding = this.store.binding(binding.chatId, binding.topicId);
    try {
      if (!binding || binding.frozen || !binding.identity) throw new Error('Unverified binding');
      const current = await this.identity(binding.paneId);
      if (Object.keys(current).some(key => current[key] !== binding.identity[key])) throw new Error('Identity mismatch');
    } catch {
      if (binding) await this.store.update(binding.chatId, binding.topicId, { frozen: true });
      throw Object.assign(new Error('Binding unverified'), { code: 'binding_unverified' });
    }
  }
  async writeInput(binding, method, params, allowClear = false) {
    await this.verify(binding);
    const wasChecking = this.store.binding(binding.chatId, binding.topicId).needs_check;
    if (wasChecking && !allowClear) throw Object.assign(new Error('Inspect input'), { code: 'needs_check' });
    // Persist intent before the mutation, so a crash also requires inspection.
    await this.store.update(binding.chatId, binding.topicId, { needs_check: true });
    await this.herdr.request(method, { pane_id: binding.paneId, ...params });
    if (!wasChecking) await this.store.update(binding.chatId, binding.topicId, { needs_check: false });
  }
  async createPane() {
    const { workspaces } = await this.herdr.request('workspace.list');
    const matching = workspaces.filter(w => w.label === 'feishu');
    if (matching.length > 1) throw new Error('Ambiguous feishu workspace');
    const params = { cwd: this.config.defaultCwd, focus: false };
    const created = matching.length
      ? await this.herdr.request('tab.create', { ...params, workspace_id: matching[0].workspace_id })
      : await this.herdr.request('workspace.create', { ...params, label: 'feishu' });
    return created.root_pane;
  }
  async list(event) {
    const [{ panes }, { agents }] = await Promise.all([this.herdr.request('pane.list'), this.herdr.request('agent.list')]);
    const text = panes.map(p => {
      const agent = agents.find(a => a.pane_id === p.pane_id && a.agent);
      return `${p.pane_id} · ${agent?.agent ?? 'shell'} · ${agent?.agent_status ?? p.agent_status}`;
    }).join('\n') || 'No panes.';
    for (const part of splitText(text)) await this.feishu.reply(event.topicId, part);
  }
  async open(event, paneId) {
    const existing = this.store.forPane(paneId);
    if (existing && !existing.frozen) { await this.feishu.reply(event.topicId, `Already bound to topic ${existing.topicId}.`); return; }
    const identity = await this.identity(paneId);
    if (existing) {
      await this.store.update(existing.chatId, existing.topicId, { identity, frozen: false, lastTranscript: undefined, nonce: randomUUID() });
      this.runtime.delete(existing.topicId);
      await this.feishu.reply(existing.topicId, 'Pane rebound; identity verified.'); return;
    }
    // A fresh top-level bot post is a topic root, even when /t open was a reply.
    const topicId = await this.feishu.send(event.chatId, `Terminal ${paneId}. Reply here to send input. /t screen shows the terminal.`);
    await this.store.bind({ chatId: event.chatId, topicId, paneId, identity });
    this.resubscribe(); this.state(this.store.binding(event.chatId, topicId));
  }
  async input(binding, text) {
    await this.verify(binding);
    if (this.store.binding(binding.chatId, binding.topicId).needs_check) throw Object.assign(new Error('Inspect input'), { code: 'needs_check' });
    const state = this.state(binding);
    // Establish the transcript baseline BEFORE input, including for /t open.
    if (!state.initialized) {
      const { read } = await this.herdr.request('pane.read', { pane_id: binding.paneId, source: 'recent_unwrapped', lines: 2000 });
      if (binding.lastTranscript === undefined) {
        state.previous = clean(read.text); state.current = state.previous;
        await this.store.update(binding.chatId, binding.topicId, { lastTranscript: state.previous });
      }
      state.initialized = true;
    }
    const { agents } = await this.herdr.request('agent.list');
    const agent = agents.find(a => a.pane_id === binding.paneId && a.agent);
    if (agent) {
      this.status(state, agent.agent_status, agent.agent);
      try { await this.herdr.request('agent.prompt', { target: binding.paneId, text }); }
      catch (error) {
        if (error.code !== 'agent_blocked') throw error;
        this.status(state, 'blocked', agent.agent); state.dirty = true;
        await this.refresh(binding, true, true); return;
      }
    } else {
      this.status(state, 'unknown', null);
      await this.store.update(binding.chatId, binding.topicId, { needs_check: true });
      await this.herdr.request('pane.send_text', { pane_id: binding.paneId, text });
      await this.verify(binding);
      await this.herdr.request('pane.send_keys', { pane_id: binding.paneId, keys: ['enter'] });
      await this.store.update(binding.chatId, binding.topicId, { needs_check: false });
    }
    state.dirty = true;
  }
  async button(event, binding) {
    if (!binding || !binding.cardId || event.messageId !== binding.cardId || event.nonce !== binding.nonce ||
      (event.key !== 'refresh' && !validKeys([event.key]))) {
      await this.feishu.reply(event.topicId || event.messageId, 'Stale or foreign card. Use /t screen for the current card.'); return;
    }
    const state = this.state(binding);
    if (event.key !== 'refresh') await this.verify(binding);
    if (event.key !== 'refresh') {
      const { agents } = await this.herdr.request('agent.list');
      if (!agents.some(a => a.pane_id === binding.paneId && a.agent && a.agent_status === 'blocked')) {
        await this.feishu.reply(binding.topicId, 'The pane is no longer blocked. Use /t screen.'); return;
      }
    }
    // Consume the nonce durably before sending any key. A replay under a new
    // event_id cannot execute the same card action again, including on restart.
    await this.store.update(binding.chatId, binding.topicId, { nonce: randomUUID() });
    await this.log(event, binding, event.key === 'refresh' ? 'refresh' : 'button_key', event.key);
    if (event.key !== 'refresh') await this.writeInput(binding, 'pane.send_keys', { keys: [event.key] });
    state.dirty = true; await this.refresh(this.store.binding(binding.chatId, binding.topicId), true);
  }
  tick() {
    if (this.tickPending || this.stopped) return Promise.resolve();
    this.tickPending = true;
    return this.enqueue(async () => {
      for (const binding of this.store.list()) {
        if (binding.chatId !== this.chatId) continue;
        const state = this.state(binding);
        try {
          if (state.dirty || this.now() - state.lastRead >= 1000 || (state.cardPending && this.now() - state.lastCard >= 1000)) await this.refresh(binding);
          await this.flush(binding);
        } catch { this.onError('output_refresh_failed'); }
      }
    }).finally(() => { this.tickPending = false; });
  }
  async refresh(binding, force = false, forceBlocked = false) {
    const state = this.state(binding), now = this.now();
    const [{ read: visible }, { read: recent }, { agents }] = await Promise.all([
      this.herdr.request('pane.read', { pane_id: binding.paneId, source: 'visible', lines: 40 }),
      this.herdr.request('pane.read', { pane_id: binding.paneId, source: 'recent_unwrapped', lines: 2000 }),
      this.herdr.request('agent.list'),
    ]);
    const agent = agents.find(a => a.pane_id === binding.paneId && a.agent);
    this.status(state, forceBlocked ? 'blocked' : agent?.agent_status ?? 'unknown', agent?.agent ?? null);
    state.lastRead = now; state.dirty = false;
    if (!state.initialized) {
      if (binding.lastTranscript === undefined) state.previous = clean(recent.text);
      state.initialized = true;
    }
    const content = clean(recent.text);
    if (content !== state.current) { state.current = content; state.lastChange = now; state.pending = true; }
    const signature = createHash('sha256').update(visible.text + '\0' + state.status).digest('hex');
    state.cardPending = state.cardPending || force || signature !== state.signature || state.blockedNotice;
    // A manual screen request and a blocked notification still obey 1 Hz.
    if (now - state.lastCard >= 1000 && state.cardPending) {
      binding = this.store.binding(binding.chatId, binding.topicId);
      const nonce = randomUUID();
      const card = screenCard({ paneId: binding.paneId, topicId: binding.topicId, nonce, status: state.status, text: visible.text });
      await this.store.update(binding.chatId, binding.topicId, { nonce });
      // Do not advance the signature on failure: the next tick will retry.
      if (binding.cardId) await this.feishu.patch(binding.cardId, card);
      else {
        const cardId = await this.feishu.reply(binding.topicId, card, 'interactive');
        await this.store.update(binding.chatId, binding.topicId, { cardId });
      }
      state.lastCard = this.now(); state.signature = signature; state.blockedNotice = false; state.cardPending = false;
    }
  }
  async flush(binding) {
    const state = this.state(binding);
    let batch = this.store.binding(binding.chatId, binding.topicId).outputBatch;
    if (!batch) {
      if (!state.pending && !state.settle) return;
      if (state.agent && !['idle', 'done'].includes(state.status)) return;
      if (!state.settle && this.now() - state.lastChange < 1500) return;
      batch = { checkpoint: state.current, next: 0,
        chunks: splitText(newOutput(state.previous, state.current)).map(text => ({ text, uuid: randomUUID() })) };
      await this.store.update(binding.chatId, binding.topicId, { outputBatch: batch });
    }
    while (batch.next < batch.chunks.length) {
      const chunk = batch.chunks[batch.next];
      // Feishu deduplicates UUIDs for one hour. Stop ambiguous retries before
      // that expires instead of risking another copy after a long outage.
      if (chunk.attemptAt !== undefined && this.now() - chunk.attemptAt >= 55 * 60 * 1000)
        throw Object.assign(new Error('Output retry window expired; inspect delivery'), { code: 'output_retry_expired' });
      if (chunk.attemptAt === undefined) {
        chunk.attemptAt = this.now();
        await this.store.update(binding.chatId, binding.topicId, { outputBatch: batch });
      }
      await this.feishu.reply(binding.topicId, chunk.text, 'text', chunk.uuid);
      batch.next++;
      await this.store.update(binding.chatId, binding.topicId, { outputBatch: batch });
    }
    await this.store.update(binding.chatId, binding.topicId, { lastTranscript: batch.checkpoint, outputBatch: null });
    state.previous = batch.checkpoint; state.pending = state.current !== batch.checkpoint; state.settle = false;
  }
}
