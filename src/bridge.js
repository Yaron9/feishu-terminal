import { randomUUID, createHash } from 'node:crypto';
import { route, validKeys } from './router.js';
import { clean, screenCard, screenText, newOutput, splitText } from './render.js';
import { paneSubscriptions } from './herdr-client.js';
import { auditRecord, appendAudit } from './store.js';
import { paneLabel } from './panes.js';

export class Bridge {
  constructor({ herdr, feishu, store, config, now = Date.now, audit, onError = () => {} }) {
    Object.assign(this, { herdr, feishu, store, config, now, onError });
    this.audit = audit ?? (record => appendAudit(config.auditFile, record));
    this.queues = new Map(); this.runtime = new Map(); this.stopped = false;
    this.chatId = config.chatIds[0];
  }
  get queue() { return Promise.all([...this.queues.values()]); }
  enqueue(fn, key = 'control') {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => this.onError('bridge_operation_failed'));
    this.queues.set(key, tail);
    tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return result;
  }
  state(binding) {
    if (!this.runtime.has(binding.topicId)) this.runtime.set(binding.topicId, {
      status: 'unknown', agent: null, dirty: true, lastRead: -Infinity, lastCard: -Infinity,
      lastChange: this.now(), current: binding.lastTranscript ?? '', previous: binding.lastTranscript ?? '',
      pending: false, settle: false, blockedNotice: false, verified: false,
    });
    return this.runtime.get(binding.topicId);
  }
  async start({ timers = true } = {}) {
    for (const b of this.store.list()) {
      this.state(b);
      if (b.chatId === this.chatId) await this.verify(b).catch(() => {});
      if (b.chatId === this.chatId && !this.store.binding(b.chatId, b.topicId).frozen && b.pendingCard)
        await this.refreshCard(b).catch(() => this.onError('card_refresh_failed'));
    }
    this.resubscribe();
    await this.feishu.start(event => this.accept(event), this.onError);
    if (timers) this.timer = setInterval(() => { this.tick().catch(() => {}); }, 250);
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.unsubscribe?.();
    this.feishu.close(); await this.queue; this.herdr.close();
  }
  resubscribe() {
    this.unsubscribe?.();
    const panes = this.store.list().filter(b => b.chatId === this.chatId && !b.frozen && this.state(b).verified).map(b => b.paneId);
    if (panes.length) this.unsubscribe = this.herdr.subscribe(paneSubscriptions(panes), event => {
      const data = event.data ?? {};
      const binding = this.store.forPane(data.pane_id ?? data.pane?.pane_id);
      if (!binding || binding.chatId !== this.chatId || binding.frozen || !this.state(binding).verified) return;
      this.enqueue(async () => {
        const state = this.state(binding); state.dirty = true;
        if (data.agent_status) this.status(state, data.agent_status, data.agent);
      }, binding.topicId).catch(() => {});
    }, connection => {
      if (connection === 'disconnected') {
        this.unsubscribe?.();
        for (const state of this.runtime.values()) { state.dirty = true; state.status = 'unknown'; state.verified = false; }
        this.enqueue(async () => {
          for (const b of this.store.list().filter(b => b.chatId === this.chatId && !b.frozen)) await this.verify(b).catch(() => {});
          if (!this.stopped) this.resubscribe();
        }, 'reconnect').catch(() => {});
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
  async claimEvent(event) {
    if (this.stopped || (event.kind === 'message' && event.senderType !== 'user')) return false;
    const ids = [event.eventId && `event:${event.eventId}`];
    if (event.kind === 'message') ids.push(event.messageId && `message:${event.messageId}`);
    else ids.push(event.callbackToken && `callback:${event.callbackToken}`);
    return this.store.claim(ids);
  }
  // SDK callbacks await only the local durable claim, never socket/API work.
  async accept(event) {
    if (await this.claimEvent(event)) this.enqueue(() => this.receive(event), event.topicId).catch(() => {});
  }
  async handle(event) {
    if (await this.claimEvent(event)) return this.enqueue(() => this.receive(event), event.topicId);
  }
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
        await this.verify(this.store.binding(event.chatId, event.messageId));
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
        try { screen = screenText((await this.readVerified(binding, () => this.herdr.request('pane.read', { pane_id: binding.paneId, source: 'visible', lines: 40 }))).read.text); } catch {}
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
    const expected = binding;
    binding = this.store.binding(binding.chatId, binding.topicId);
    if (!this.sameGeneration(expected, binding)) throw Object.assign(new Error('Binding changed'), { code: 'binding_changed' });
    try {
      if (!binding || binding.frozen || !binding.identity) throw new Error('Unverified binding');
      const current = await this.identity(binding.paneId);
      const latest = this.store.binding(binding.chatId, binding.topicId);
      if (!this.sameGeneration(binding, latest) || latest.frozen || Object.keys(current).some(key => current[key] !== binding.identity[key] || current[key] !== expected.identity?.[key] || current[key] !== latest.identity?.[key]))
        throw new Error('Identity mismatch');
      this.state(binding).verified = true;
    } catch {
      if (binding && this.sameGeneration(binding, this.store.binding(binding.chatId, binding.topicId))) {
        await this.updateGeneration(binding, { frozen: true, discardedOutput: Boolean(binding.outputBatch) || binding.discardedOutput,
          outputBatch: null, pendingCard: null });
        this.runtime.delete(binding.topicId);
        this.resubscribe();
      }
      throw Object.assign(new Error('Binding unverified'), { code: 'binding_unverified' });
    }
  }
  sameGeneration(binding, current) {
    return Boolean(current && (binding.generation ?? 0) === (current.generation ?? 0));
  }
  updateGeneration(binding, patch) {
    return this.store.transaction(data => {
      const current = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
      if (!this.sameGeneration(binding, current)) return false;
      Object.assign(current, patch); return true;
    });
  }
  async readVerified(binding, read) {
    await this.verify(binding);
    const result = await read();
    // Neither read API carries terminal identity. Discard both snapshots if
    // the server changed between verification and the completed reads.
    await this.verify(binding);
    return result;
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
    return this.enqueue(() => this.createPaneSerial(), 'pane-create');
  }
  async createPaneSerial() {
    const { workspaces } = await this.herdr.request('workspace.list');
    const matching = workspaces.filter(w => w.label === 'feishu');
    if (matching.length > 1) throw new Error('Ambiguous feishu workspace');
    const params = { cwd: this.config.defaultCwd, focus: false };
    const created = matching.length
      ? await this.herdr.request('tab.create', { ...params, workspace_id: matching[0].workspace_id })
      : await this.herdr.request('workspace.create', { ...params, label: 'feishu' });
    const pane = created.root_pane;
    if (pane?.terminal_id) await this.store.transaction(data => {
      data.createdTerminals ??= [];
      if (!data.createdTerminals.includes(pane.terminal_id)) data.createdTerminals.push(pane.terminal_id);
    });
    return pane;
  }
  label(pane) {
    return paneLabel(pane, { bound: this.store.list().some(b => b.chatId === this.chatId && b.paneId === pane.pane_id),
      owned: this.store.data.createdTerminals?.includes(pane.terminal_id) });
  }
  async list(event) {
    const { panes } = await this.herdr.request('pane.list');
    const text = panes.map(p => this.label(p)).join('\n') || 'No panes.';
    for (const part of splitText(text)) await this.feishu.reply(event.topicId, part);
  }
  async open(event, paneId) {
    const existing = this.store.forPane(paneId);
    if (existing && !existing.frozen) { await this.feishu.reply(event.topicId, `Already bound to topic ${existing.topicId}.`); return; }
    const identity = await this.identity(paneId);
    if (existing) {
      await this.store.update(existing.chatId, existing.topicId, { identity, generation: randomUUID(), frozen: false,
        lastTranscript: undefined, nonce: randomUUID(), pendingCard: null, outputBatch: null, discardedOutput: false });
      this.runtime.delete(existing.topicId);
      await this.verify(this.store.binding(existing.chatId, existing.topicId)); this.resubscribe();
      if (existing.outputBatch || existing.discardedOutput) await this.feishu.reply(existing.topicId, '旧终端未发送完的输出已丢弃');
      await this.feishu.reply(existing.topicId, 'Pane rebound; identity verified.'); return;
    }
    // A fresh top-level bot post is a topic root, even when /t open was a reply.
    const { panes } = await this.herdr.request('pane.list');
    const pane = panes.find(p => p.pane_id === paneId && p.terminal_id === identity.terminalId);
    if (!pane) throw new Error('Unconfirmed pane identity');
    const topicId = await this.feishu.send(event.chatId, `终端：${this.label(pane)}`);
    await this.store.bind({ chatId: event.chatId, topicId, paneId, identity });
    await this.verify(this.store.binding(event.chatId, topicId));
    this.resubscribe(); this.state(this.store.binding(event.chatId, topicId));
  }
  async input(binding, text) {
    await this.verify(binding);
    if (this.store.binding(binding.chatId, binding.topicId).needs_check) throw Object.assign(new Error('Inspect input'), { code: 'needs_check' });
    const state = this.state(binding);
    // Establish the transcript baseline BEFORE input, including for /t open.
    if (!state.initialized) {
      const { read } = await this.readVerified(binding, () => this.herdr.request('pane.read', { pane_id: binding.paneId, source: 'recent_unwrapped', lines: 2000 }));
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
    if (!await this.store.consumeCard(binding.chatId, binding.topicId, event.messageId, event.nonce)) {
      await this.feishu.reply(binding.topicId, 'Stale card. Use /t screen.'); return;
    }
    await this.log(event, binding, event.key === 'refresh' ? 'refresh' : 'button_key', event.key);
    if (event.key !== 'refresh') await this.writeInput(binding, 'pane.send_keys', { keys: [event.key] });
    state.dirty = true; await this.refresh(this.store.binding(binding.chatId, binding.topicId), true);
  }
  tick() {
    if (this.tickPending || this.stopped) return Promise.resolve();
    this.tickPending = true;
    return Promise.all(this.store.list().filter(b => b.chatId === this.chatId && !b.frozen && this.state(b).verified).map(binding =>
      this.enqueue(async () => {
        if (!this.store.binding(binding.chatId, binding.topicId)) return;
        const state = this.state(binding);
        try {
          if (state.dirty || this.now() - state.lastRead >= 1000) await this.refresh(binding, false, false, true);
        } catch { this.onError('output_refresh_failed'); }
        try { await this.flush(binding); } catch { this.onError('output_flush_failed'); }
        try { await this.refreshCard(binding); } catch { this.onError('card_refresh_failed'); }
      }, `output:${binding.topicId}`)
    )).finally(() => { this.tickPending = false; });
  }
  async refresh(binding, force = false, forceBlocked = false, deferCard = false) {
    const state = this.state(binding), now = this.now();
    const [{ read: visible }, { read: recent }, { agents }] = await this.readVerified(binding, () => Promise.all([
      this.herdr.request('pane.read', { pane_id: binding.paneId, source: 'visible', lines: 40 }),
      this.herdr.request('pane.read', { pane_id: binding.paneId, source: 'recent_unwrapped', lines: 2000 }),
      this.herdr.request('agent.list'),
    ]));
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
    state.visible = visible.text; state.nextSignature = signature;
    if (!deferCard) await this.refreshCard(binding);
  }
  refreshCard(binding) {
    return this.enqueue(() => this.publishCard(binding), `card:${binding.topicId}`);
  }
  async publishCard(binding) {
    const state = this.state(binding), now = this.now();
    const current = this.store.binding(binding.chatId, binding.topicId);
    if (!this.sameGeneration(binding, current)) return;
    binding = current;
    if (!binding || binding.frozen || !state.verified) return;
    // A manual screen request and a blocked notification still obey 1 Hz.
    if (now - state.lastCard >= 1000 && now >= (state.cardRetryAt ?? 0) && (state.cardPending || binding.pendingCard)) {
      await this.verify(binding);
      let pending = binding.pendingCard;
      if (!pending) {
        const nonce = randomUUID();
        const { panes } = await this.herdr.request('pane.list');
        const pane = panes.find(p => p.pane_id === binding.paneId && p.terminal_id === binding.identity.terminalId);
        if (!pane) throw Object.assign(new Error('Binding unverified'), { code: 'binding_unverified' });
        pending = { nonce, targetId: binding.cardId ?? null, uuid: randomUUID(), signature: state.nextSignature,
          card: screenCard({ paneId: binding.paneId, label: this.label(pane), topicId: binding.topicId, nonce, status: state.status, text: state.visible }) };
        if (!await this.updateGeneration(binding, { pendingCard: pending })) return;
      }
      try {
        let cardId = pending.targetId;
        if (cardId) {
          await this.verify(binding);
          try { await this.feishu.patch(cardId, pending.card); }
          catch (error) {
            if (!['230011', '230031', '230110'].includes(String(error.code))) throw error;
            pending.targetId = null; cardId = null;
            if (!await this.updateGeneration(binding, { pendingCard: pending })) return;
          }
        }
        if (!cardId) {
          if (pending.attemptAt !== undefined && this.now() - pending.attemptAt >= 55 * 60 * 1000)
            throw Object.assign(new Error('Card retry window expired'), { code: 'card_retry_expired' });
          if (pending.attemptAt === undefined) {
            pending.attemptAt = this.now();
            if (!await this.updateGeneration(binding, { pendingCard: pending })) return;
          }
          await this.verify(binding);
          cardId = await this.feishu.reply(binding.topicId, pending.card, 'interactive', pending.uuid);
        }
        // The old nonce stays valid until publication succeeds. A pending
        // version always has a fresh nonce; consumed versions are never reused.
        await this.store.transaction(data => {
          const b = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
          if (b?.pendingCard?.nonce === pending.nonce) Object.assign(b, { cardId, nonce: pending.nonce, pendingCard: null });
        });
      } catch (error) {
        state.cardFailures = (state.cardFailures ?? 0) + 1;
        state.cardRetryAt = this.now() + Math.min(30000, 1000 * 2 ** (state.cardFailures - 1));
        throw error;
      }
      state.cardFailures = 0; state.cardRetryAt = 0;
      state.lastCard = this.now(); state.signature = pending.signature; state.blockedNotice = false;
      state.cardPending = state.nextSignature !== pending.signature;
    }
  }
  async flush(binding) {
    const current = this.store.binding(binding.chatId, binding.topicId);
    if (!this.sameGeneration(binding, current)) return;
    binding = current;
    if (!binding || binding.frozen || !this.state(binding).verified) return;
    await this.verify(binding);
    const state = this.state(binding);
    let batch = this.store.binding(binding.chatId, binding.topicId).outputBatch;
    if (batch && (batch.generation ?? 0) !== (binding.generation ?? 0)) {
      await this.updateGeneration(binding, { outputBatch: null }); return;
    }
    if (!batch) {
      if (!state.pending && !state.settle) return;
      if (state.agent && !['idle', 'done'].includes(state.status)) return;
      if (!state.settle && this.now() - state.lastChange < 1500) return;
      batch = { generation: binding.generation ?? 0, checkpoint: state.current, next: 0,
        chunks: splitText(newOutput(state.previous, state.current)).map(text => ({ text, uuid: randomUUID() })) };
      if (!await this.updateGeneration(binding, { outputBatch: batch })) return;
    }
    while (batch.next < batch.chunks.length) {
      if (!this.sameGeneration(binding, this.store.binding(binding.chatId, binding.topicId))) return;
      const chunk = batch.chunks[batch.next];
      // Feishu deduplicates UUIDs for one hour. Stop ambiguous retries before
      // that expires instead of risking another copy after a long outage.
      if (chunk.attemptAt !== undefined && this.now() - chunk.attemptAt >= 55 * 60 * 1000)
        throw Object.assign(new Error('Output retry window expired; inspect delivery'), { code: 'output_retry_expired' });
      if (chunk.attemptAt === undefined) {
        chunk.attemptAt = this.now();
        if (!await this.updateGeneration(binding, { outputBatch: batch })) return;
      }
      await this.verify(binding);
      await this.feishu.reply(binding.topicId, chunk.text, 'text', chunk.uuid);
      batch.next++;
      if (!await this.updateGeneration(binding, { outputBatch: batch })) return;
    }
    if (!await this.updateGeneration(binding, { lastTranscript: batch.checkpoint, outputBatch: null })) return;
    state.previous = batch.checkpoint; state.pending = state.current !== batch.checkpoint; state.settle = false;
  }
}
