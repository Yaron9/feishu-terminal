import { randomUUID, createHash } from 'node:crypto';
import { route, validKeys } from './router.js';
import { clean, screenCard, screenText, newOutput, splitText, stripChrome, assistantCard, outputCard, turnCard } from './render.js';
import { turnChunks, turnSignature, freshTurn } from './turns.js';
import { transcriptAdapters } from './transcripts/index.js';
import { paneSubscriptions } from './herdr-client.js';
import { readPane } from './pane-read.js';
import { auditRecord, appendAudit } from './store.js';
import { paneLabel } from './panes.js';
import { PanePicker } from './picker.js';

export class Bridge {
  constructor({ herdr, feishu, store, config, now = Date.now, audit, onError = () => {}, adapters = transcriptAdapters() }) {
    Object.assign(this, { herdr, feishu, store, config, now, onError });
    this.audit = audit ?? (record => appendAudit(config.auditFile, record));
    this.queues = new Map(); this.runtime = new Map(); this.stopped = false;
    this.chatId = config.chatIds[0];
    this.picker = new PanePicker(this);
    this.adapters = adapters;
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
      if (b.chatId === this.chatId && this.state(b).verified)
        await this.initializeTranscript(b).catch(() => this.onError('transcript_unavailable'));
      if (b.chatId === this.chatId && !this.store.binding(b.chatId, b.topicId).frozen && (b.pendingCard || b.retiredCardId))
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
    if (await this.claimEvent(event)) this.enqueue(() => this.receive(event), event.key?.startsWith('picker:') ? 'picker' : event.topicId).catch(() => {});
  }
  async handle(event) {
    if (await this.claimEvent(event)) return this.enqueue(() => this.receive(event), event.key?.startsWith('picker:') ? 'picker' : event.topicId);
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
      if (action.type === 'closePicker') { await this.picker.show(event, binding); return; }
      if (action.type === 'open') { await this.open(event, action.paneId); return; }
      if (action.type === 'move') { await this.move(event, action.paneId ?? binding.paneId); return; }
      if (action.type === 'create') {
        if (event.isReply) { await this.feishu.reply(event.topicId, 'This topic is not bound. Use /t open <pane_id> in the group.'); return; }
        const pane = await this.createPane();
        const identity = await this.identity(pane.pane_id);
        await this.store.bind({ chatId: event.chatId, topicId: event.messageId, paneId: pane.pane_id, identity,
          topicRoot: { text: event.text, createdAt: Number.isFinite(event.createdAt) ? event.createdAt : this.now() } });
        await this.verify(this.store.binding(event.chatId, event.messageId));
        this.resubscribe();
        const created = this.store.binding(event.chatId, event.messageId);
        await this.log(event, created, 'first_input', action.text);
        await this.input(created, action.text);
        return;
      }
      if (action.type === 'close') {
        if (action.kill) {
          await this.verify(binding);
          const { panes } = await this.herdr.request('pane.list');
          if (!panes.some(p => p.pane_id === binding.paneId && p.terminal_id === binding.identity.terminalId))
            throw Object.assign(new Error('Binding unverified'), { code: 'binding_unverified' });
          await this.herdr.request('pane.close', { pane_id: binding.paneId });
        }
        await this.store.unbind(binding.chatId, binding.topicId); this.runtime.delete(binding.topicId); this.resubscribe();
        await this.feishu.reply(binding.topicId, action.kill ? 'Pane closed; topic unbound.' : 'Topic unbound; pane is still running.');
        return;
      }
      if (action.type === 'screen') {
        this.state(binding).dirty = true; await this.refresh(binding, true);
        const { read } = await this.readVerified(binding, () => readPane(this.herdr, binding.paneId, { source: 'visible' }));
        for (const part of splitText(clean(read.text), 4000)) {
          await this.verify(binding);
          await this.feishu.reply(binding.topicId, outputCard(part, { full: true }), 'interactive');
        }
        return;
      }
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
        try { screen = screenText((await this.readVerified(binding, () => readPane(this.herdr, binding.paneId, { source: 'visible', lines: 40 }))).read.text); } catch {}
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
  async identity(paneId, allowDesktop = false) {
    const [{ pane }, { workspaces }] = await Promise.all([
      this.herdr.request('pane.get', { pane_id: paneId }), this.herdr.request('workspace.list'),
    ]);
    if (pane?.pane_id !== paneId || !pane.terminal_id || !pane.tab_id ||
      !workspaces.some(w => w.workspace_id === pane.workspace_id && (allowDesktop || w.label === 'feishu'))) throw new Error('Unconfirmed pane identity');
    return { terminalId: pane.terminal_id, workspaceId: pane.workspace_id, tabId: pane.tab_id };
  }
  async verify(binding) {
    const expected = binding;
    binding = this.store.binding(binding.chatId, binding.topicId);
    if (!this.sameGeneration(expected, binding)) throw Object.assign(new Error('Binding changed'), { code: 'binding_changed' });
    try {
      if (!binding || binding.frozen || !binding.identity) throw new Error('Unverified binding');
      const current = await this.identity(binding.paneId, binding.allowDesktop);
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
    if (method === 'pane.send_text') {
      await this.initializeTranscript(binding);
      await this.rememberInput(binding, params.text);
    }
    await this.herdr.request(method, { pane_id: binding.paneId, ...params });
    if (!wasChecking) await this.store.update(binding.chatId, binding.topicId, { needs_check: false });
  }
  agentName(agent) { return String(agent).toLowerCase() === 'claude' ? 'Claude' : String(agent).toLowerCase() === 'codex' ? 'Codex' : String(agent); }
  inputHash(text) { return createHash('sha256').update(clean(text).trim()).digest('hex'); }
  async rememberInput(binding, text) {
    const id = randomUUID(), now = this.now();
    await this.store.transaction(data => {
      const b = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
      if (!this.sameGeneration(binding, b)) throw new Error('Binding changed');
      b.sentInputs = [...(b.sentInputs ?? []).filter(item => item.expires > now),
        { id, hash: this.inputHash(text), expires: now + 600000 }].slice(-100);
    });
    return id;
  }
  async initializeTranscript(binding, pane) {
    const state = this.state(binding);
    try {
      if (!pane) ({ pane } = await this.readVerified(binding, () => this.herdr.request('pane.get', { pane_id: binding.paneId })));
      const key = String(pane.agent ?? '').toLowerCase(), adapter = this.adapters[key];
      if (!adapter) { state.transcriptSource = null; return; }
      const path = await this.readVerified(binding, () => adapter.locate(pane));
      if (!path) { state.transcriptSource = null; return; }
      if (state.failedTranscript === path && this.now() < state.transcriptRetryAt) { state.transcriptSource = null; return; }
      const current = this.store.binding(binding.chatId, binding.topicId);
      if (!this.sameGeneration(binding, current)) return;
      // Legacy bindings and resumed sessions start at EOF: never replay history.
      // A pending batch owns its old checkpoint until delivery is reconciled.
      if ((!current.transcript || current.transcript.path !== path || current.transcript.adapter !== key) && !current.outputBatch?.transcript) {
        const { cursor } = await this.readVerified(binding, () => adapter.read(path, { atEnd: true }));
        if (!await this.updateGeneration(binding, { transcript: { adapter: key, path, cursor } })) return;
      }
      state.transcriptSource = { key, path, adapter };
    } catch (error) {
      state.transcriptSource = null;
      if (error.code === 'binding_unverified' || error.code === 'binding_changed') throw error;
      this.onError('transcript_unavailable');
    }
  }
  async transcriptBatch(binding) {
    const state = this.state(binding), source = state.transcriptSource;
    const current = this.store.binding(binding.chatId, binding.topicId), checkpoint = current.transcript;
    if (!checkpoint || checkpoint.path !== source.path || checkpoint.adapter !== source.key) return null;
    const { items, cursor } = await this.readVerified(binding, () => source.adapter.read(source.path, checkpoint.cursor));
    if (JSON.stringify(cursor) === JSON.stringify(checkpoint.cursor)) return null;
    const inputs = (current.sentInputs ?? []).filter(item => item.expires > this.now());
    const { chunks, consumedInputs } = turnChunks(items, current.turn, source,
      this.agentName(source.key), state.status, inputs, text => this.inputHash(text));
    return { generation: binding.generation ?? 0, checkpoint: state.current, next: 0, chunks, consumedInputs,
      transcript: { adapter: source.key, path: source.path, cursor } };
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
    const binding = this.store.list().find(b => b.chatId === this.chatId && b.paneId === pane.pane_id);
    return paneLabel(pane, { bound: Boolean(binding), frozen: Boolean(binding?.frozen),
      owned: this.store.data.createdTerminals?.includes(pane.terminal_id) });
  }
  async list(event) {
    await this.picker.show(event);
  }
  async open(event, paneId, expectedTerminalId) {
    return this.enqueue(() => this.openSerial(event, paneId, expectedTerminalId), `open:${paneId}`);
  }
  async openSerial(event, paneId, expectedTerminalId) {
    const existing = this.store.forPane(paneId);
    if (existing && existing.chatId !== event.chatId) throw new Error('终端已变化，请重新 /t ls');
    if (existing && !existing.frozen) return this.recoverOpen(event, existing, expectedTerminalId);
    const identity = await this.identity(paneId, Boolean(expectedTerminalId));
    if (expectedTerminalId && identity.terminalId !== expectedTerminalId) throw new Error('终端已变化，请重新 /t ls');
    if (existing) {
      await this.store.update(existing.chatId, existing.topicId, { identity, generation: randomUUID(), frozen: false,
        lastTranscript: undefined, transcript: null, turn: null, cardTurnId: null, cardSignature: null,
        sentInputs: [], nonce: randomUUID(), pendingCard: null, outputBatch: null, discardedOutput: false });
      this.runtime.delete(existing.topicId);
      await this.verify(this.store.binding(existing.chatId, existing.topicId)); this.resubscribe();
      if (existing.outputBatch || existing.discardedOutput) await this.feishu.reply(existing.topicId, '旧终端未发送完的输出已丢弃');
      await this.feishu.reply(existing.topicId, 'Pane rebound; identity verified.');
      return this.recoverOpen(event, this.store.binding(existing.chatId, existing.topicId), expectedTerminalId);
    }
    // A fresh top-level bot post is a topic root, even when /t open was a reply.
    const { panes } = await this.herdr.request('pane.list');
    const pane = panes.find(p => p.pane_id === paneId && p.terminal_id === identity.terminalId);
    if (!pane) throw new Error('Unconfirmed pane identity');
    const text = `终端：${this.label(pane)}`, createdAt = this.now();
    const topicId = await this.feishu.send(event.chatId, text);
    await this.store.bind({ chatId: event.chatId, topicId, paneId, identity, topicRoot: { text, createdAt },
      ...(expectedTerminalId ? { allowDesktop: true } : {}) });
    await this.verify(this.store.binding(event.chatId, topicId));
    await this.initializeTranscript(this.store.binding(event.chatId, topicId));
    this.resubscribe(); this.state(this.store.binding(event.chatId, topicId));
    return topicId;
  }
  async topicDescription(binding) {
    let root = this.store.binding(binding.chatId, binding.topicId)?.topicRoot;
    if (!root) {
      try {
        const message = await this.feishu.getMessage(binding.topicId);
        const text = JSON.parse(message.body.content).text;
        const createdAt = Number(message.create_time);
        if (typeof text === 'string' && Number.isFinite(createdAt)) {
          root = { text, createdAt };
          await this.updateGeneration(binding, { topicRoot: root });
        }
      } catch { /* Legacy roots may be unavailable; moving remains possible. */ }
    }
    const chars = Array.from(root?.text ?? binding.topicId);
    const title = chars.slice(0, 30).join('') + (chars.length > 30 ? '…' : '');
    const time = Number.isFinite(root?.createdAt) ? new Date(root.createdAt + 8 * 3600000).toISOString().slice(11, 16) : '--:--';
    return `「${title}」(${time})`;
  }
  move(event, paneId, expected) {
    // Share open's pane lock, then drain output and status publication before
    // changing destinations. No old batch/UUID can leak into the new topic.
    return this.enqueue(async () => {
      const binding = this.store.forPane(paneId);
      if (!binding || binding.chatId !== event.chatId || (expected &&
        (expected.bindingTopic !== binding.topicId || expected.generation !== binding.generation)))
        throw new Error('终端已变化，请重新 /t ls');
      return this.enqueue(async () => {
        await this.verify(binding);
        if (this.store.binding(binding.chatId, binding.topicId).outputBatch) {
          await this.flush(binding);
          if (this.store.binding(binding.chatId, binding.topicId).outputBatch) throw new Error('Output delivery pending');
        }
        return this.enqueue(async () => {
          // A turn may have an uncertain status publication without an output batch.
          if (this.store.binding(binding.chatId, binding.topicId).pendingCard) {
            await this.publishCard(binding);
            if (this.store.binding(binding.chatId, binding.topicId).pendingCard) throw new Error('Card delivery pending');
          }
          const { panes } = await this.herdr.request('pane.list');
          const pane = panes.find(p => p.pane_id === paneId && p.terminal_id === binding.identity.terminalId);
          if (!pane) throw new Error('终端已变化，请重新 /t ls');
          const text = `终端：${this.label(pane)}`, createdAt = this.now();
          await this.verify(binding);
          const topicId = await this.feishu.send(event.chatId, text);
          await this.verify(binding);
          const moved = await this.store.transaction(data => {
            const current = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
            if (!this.sameGeneration(binding, current) || current.frozen) throw new Error('终端已变化，请重新 /t ls');
            Object.assign(current, { topicId, generation: randomUUID(), nonce: randomUUID(), cardId: null,
              cardCreatedAt: null, cardTurnId: null, cardSignature: null, pendingCard: null,
              retiredCardId: undefined, retiredCardAt: undefined, outputBatch: null,
              topicRoot: { text, createdAt } });
            return structuredClone(current);
          });
          const state = this.state(binding);
          this.runtime.delete(binding.topicId);
          this.runtime.set(topicId, { ...state, verified: false, lastCard: -Infinity, cardRetryAt: 0,
            retireRetryAt: 0, cardPending: true, dirty: true });
          await this.verify(moved); this.resubscribe();
          try { await this.refresh(moved, true); }
          finally {
            await this.feishu.reply(binding.topicId, `已移到新话题「${text}」`).catch(() => {});
          }
          return topicId;
        }, `card:${binding.topicId}`);
      }, `output:${binding.topicId}`);
    }, `open:${paneId}`);
  }
  async recoverOpen(event, binding, expectedTerminalId) {
    const label = await this.resumeTopic(binding, expectedTerminalId);
    if (event.kind === 'message' && event.isReply && event.topicId !== binding.topicId)
      await this.feishu.reply(event.topicId, `该终端已绑定在话题「${label}」，已为你置顶该话题`);
    return binding.topicId;
  }
  async resumeTopic(binding, expectedTerminalId) {
    return this.enqueue(async () => {
      await this.verify(binding);
      if (expectedTerminalId && binding.identity.terminalId !== expectedTerminalId) throw new Error('终端已变化，请重新 /t ls');
      // Reconcile an older pending publication before preparing another version.
      if (this.store.binding(binding.chatId, binding.topicId).pendingCard) {
        await this.publishCard(binding, true);
        if (this.store.binding(binding.chatId, binding.topicId).pendingCard) throw new Error('Card delivery pending');
      }
      await this.retireCard(binding);
      if (this.store.binding(binding.chatId, binding.topicId).retiredCardId) throw new Error('Previous card retirement pending');
      await this.refresh(binding, true, false, true);
      let current = this.store.binding(binding.chatId, binding.topicId);
      if (this.state(binding).transcriptSource && !current.turn) {
        const source = this.state(binding).transcriptSource;
        const turn = freshTurn(source, this.agentName(source.key), this.state(binding).status);
        if (['idle', 'done'].includes(this.state(binding).status)) { turn.settled = true; turn.status = 'idle'; }
        await this.updateGeneration(binding, { turn });
        current = this.store.binding(binding.chatId, binding.topicId);
      }
      const pending = await this.prepareCard(current, true);
      if (!await this.updateGeneration(current, { pendingCard: pending })) throw new Error('Binding changed');
      await this.publishCard(current, true);
      if (this.store.binding(current.chatId, current.topicId)?.nonce !== pending.nonce) throw new Error('Card publication incomplete');
      return pending.card.header.title.content;
    }, `card:${binding.topicId}`);
  }
  async input(binding, text) {
    await this.verify(binding);
    if (this.store.binding(binding.chatId, binding.topicId).needs_check) throw Object.assign(new Error('Inspect input'), { code: 'needs_check' });
    const state = this.state(binding);
    await this.initializeTranscript(binding);
    // Establish the transcript baseline BEFORE input, including for /t open.
    if (!state.initialized) {
      const { read } = await this.readVerified(binding, () => readPane(this.herdr, binding.paneId,
        state.transcriptSource ? { source: 'visible' } : {}));
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
      const inputId = await this.rememberInput(binding, text);
      try { await this.herdr.request('agent.prompt', { target: binding.paneId, text }); }
      catch (error) {
        if (error.code !== 'agent_blocked') throw error;
        await this.store.transaction(data => {
          const b = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
          if (this.sameGeneration(binding, b)) b.sentInputs = (b.sentInputs ?? []).filter(item => item.id !== inputId);
        });
        this.status(state, 'blocked', agent.agent); state.dirty = true;
        await this.refresh(binding, true, true); return;
      }
    } else {
      this.status(state, 'unknown', null);
      await this.store.update(binding.chatId, binding.topicId, { needs_check: true });
      await this.rememberInput(binding, text);
      await this.herdr.request('pane.send_text', { pane_id: binding.paneId, text });
      await this.verify(binding);
      await this.herdr.request('pane.send_keys', { pane_id: binding.paneId, keys: ['enter'] });
      await this.store.update(binding.chatId, binding.topicId, { needs_check: false });
    }
    state.dirty = true;
  }
  async button(event, binding) {
    if (event.key?.startsWith('picker:')) { await this.picker.button(event); return; }
    if (!binding || !binding.cardId || event.messageId !== binding.cardId || event.nonce !== binding.nonce ||
      (event.key !== 'refresh' && !validKeys([event.key]))) {
      await this.feishu.reply(event.topicId || event.messageId, 'Stale or foreign card. Use /t screen for the current card.'); return;
    }
    const state = this.state(binding);
    if (!Number.isFinite(binding.cardCreatedAt) || this.now() - binding.cardCreatedAt >= 600000 || this.now() < binding.cardCreatedAt) {
      await this.feishu.reply(event.topicId, '卡片已过期，请重新 /t screen'); return;
    }
    try { await this.verify(binding); }
    catch { await this.feishu.reply(event.topicId, '终端已变化，请重新 /t ls'); return; }
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
    const [{ read: visible }, { agents }, { panes }] = await this.readVerified(binding, () => Promise.all([
      readPane(this.herdr, binding.paneId, { source: 'visible', lines: 40 }),
      this.herdr.request('agent.list'),
      this.herdr.request('pane.list'),
    ]));
    const agent = agents.find(a => a.pane_id === binding.paneId && a.agent);
    this.status(state, forceBlocked ? 'blocked' : agent?.agent_status ?? 'unknown', agent?.agent ?? null);
    state.lastRead = now; state.dirty = false;
    const pane = panes.find(p => p.pane_id === binding.paneId && p.terminal_id === binding.identity.terminalId);
    if (!pane) throw Object.assign(new Error('Binding unverified'), { code: 'binding_unverified' });
    await this.initializeTranscript(binding, { ...pane, agent: agent?.agent ?? pane.agent });
    const recent = state.transcriptSource ? visible : (await this.readVerified(binding, () => readPane(this.herdr, binding.paneId))).read;
    if (!state.initialized) {
      if (binding.lastTranscript === undefined) state.previous = clean(recent.text);
      state.initialized = true;
    }
    const content = clean(recent.text);
    if (content !== state.current) { state.current = content; state.lastChange = now; state.pending = true; }
    const signature = createHash('sha256').update(visible.text + '\0' + state.status + '\0' + this.label(pane)).digest('hex');
    state.cardPending = state.cardPending || force || signature !== state.signature || state.blockedNotice;
    state.visible = visible.text; state.nextSignature = signature;
    if (state.transcriptSource && force) state.forceTurnCard = true;
    if (!deferCard) await this.refreshCard(binding);
  }
  refreshCard(binding) {
    return this.enqueue(() => this.publishCard(binding), `card:${binding.topicId}`);
  }
  turnMode(binding) {
    return Boolean(this.state(binding).transcriptSource || binding.pendingCard?.turnId ||
      binding.outputBatch?.chunks[binding.outputBatch.next]?.turn);
  }
  async prepareCard(binding, resume = false) {
    const state = this.state(binding), nonce = randomUUID();
    await this.verify(binding);
    const { panes } = await this.herdr.request('pane.list');
    const pane = panes.find(p => p.pane_id === binding.paneId && p.terminal_id === binding.identity.terminalId);
    if (!pane) throw Object.assign(new Error('Binding unverified'), { code: 'binding_unverified' });
    if (this.turnMode(binding) && binding.turn) {
      const turn = binding.turn, newTurn = binding.cardTurnId !== turn.id;
      return { nonce, createdAt: this.now(), targetId: resume || newTurn ? null : binding.cardId ?? null,
        ...((resume || (newTurn && !binding.cardTurnId)) && binding.cardId ? {
          previousCardId: binding.cardId,
          ...(binding.cardTurnId ? { previousCardAt: binding.cardAttemptAt } : {}),
        } : {}),
        uuid: randomUUID(), turnId: turn.id, signature: turnSignature(turn),
        card: turnCard({ turn, topicId: binding.topicId, nonce, ...(resume ? { note: '📍 已从终端列表恢复' } : {}) }) };
    }
    return { nonce, createdAt: this.now(), targetId: resume ? null : binding.cardId ?? null,
      ...(resume && binding.cardId ? { previousCardId: binding.cardId } : {}),
      uuid: randomUUID(), signature: state.nextSignature,
      card: screenCard({ paneId: binding.paneId, label: this.label(pane), topicId: binding.topicId, nonce,
        status: state.status, text: state.visible, ...(resume ? { note: '📍 已从终端列表恢复' } : {}) }) };
  }
  async retireCard(binding) {
    const current = this.store.binding(binding.chatId, binding.topicId);
    if (!this.sameGeneration(binding, current) || !current.retiredCardId) return;
    const state = this.state(binding);
    if (this.now() < (state.retireRetryAt ?? 0)) return;
    if (Number.isFinite(current.retiredCardAt) && this.now() - current.retiredCardAt < 2000) return;
    try {
      await this.verify(current);
      if (Number.isFinite(current.retiredCardAt) && !await this.updateGeneration(current, { retiredCardAt: this.now() })) return;
      await this.feishu.patch(current.retiredCardId, {
        config: { wide_screen_mode: true, update_multi: true },
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: '已移至下方新卡片' } }],
      });
    } catch (error) {
      if (!['230011', '230031', '230110'].includes(String(error.code))) {
        state.retireFailures = (state.retireFailures ?? 0) + 1;
        state.retireRetryAt = this.now() + Math.min(30000, 1000 * 2 ** (state.retireFailures - 1));
        this.onError('card_retirement_failed'); return;
      }
    }
    state.retireFailures = 0; state.retireRetryAt = 0;
    await this.store.transaction(data => {
      const b = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
      if (this.sameGeneration(binding, b) && b.retiredCardId === current.retiredCardId) {
        delete b.retiredCardId; delete b.retiredCardAt;
      }
    });
  }
  async publishCard(binding, immediate = false) {
    const state = this.state(binding), now = this.now();
    const current = this.store.binding(binding.chatId, binding.topicId);
    if (!this.sameGeneration(binding, current)) return;
    binding = current;
    if (!binding || binding.frozen || !state.verified) return;
    await this.retireCard(binding);
    if (this.turnMode(binding)) {
      // The transcript turn is the status card. Idle panes with no observed
      // turn never acquire a separate live-screen reply.
      if (!binding.turn && !binding.pendingCard) return;
      if (binding.turn) {
        if (!binding.turn.settled && ['blocked', 'working'].includes(state.status) &&
          (binding.turn.status !== state.status || !binding.turn.activeObserved)) {
          binding.turn.status = state.status; binding.turn.activeObserved = true;
          if (!await this.updateGeneration(binding, { turn: binding.turn })) return;
        }
        state.nextSignature = turnSignature(binding.turn);
        state.cardPending = state.forceTurnCard || binding.cardTurnId !== binding.turn.id ||
          binding.cardSignature !== state.nextSignature || binding.cardNonce !== binding.nonce;
      }
    }
    // Turn patches, including manual refresh and retries, obey a durable 2 s
    // interval. Fallback status cards keep 1 Hz; recovery sends a new reply.
    const turnPublication = this.turnMode(binding) && binding.turn;
    const targetId = binding.pendingCard ? binding.pendingCard.targetId :
      turnPublication && binding.cardTurnId !== binding.turn?.id ? null : binding.cardId;
    const turnThrottled = turnPublication && targetId && binding.cardAttemptId === targetId &&
      now - binding.cardAttemptAt < 2000;
    const ready = turnPublication ? !turnThrottled && now >= (state.cardRetryAt ?? 0) :
      immediate || (now - state.lastCard >= 1000 && now >= (state.cardRetryAt ?? 0));
    if (ready && (state.cardPending || binding.pendingCard)) {
      await this.verify(binding);
      let pending = binding.pendingCard;
      if (!pending) {
        pending = await this.prepareCard(binding);
        if (!await this.updateGeneration(binding, { pendingCard: pending })) return;
      }
      try {
        let cardId = pending.targetId;
        if (cardId) {
          await this.verify(binding);
          if (pending.turnId && !await this.updateGeneration(binding, { cardAttemptId: cardId, cardAttemptAt: this.now() })) return;
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
          if (this.sameGeneration(binding, b) && b.pendingCard?.nonce === pending.nonce) {
            Object.assign(b, { cardId, nonce: pending.nonce, cardCreatedAt: pending.createdAt, pendingCard: null,
              cardTurnId: pending.turnId ?? null, cardSignature: pending.signature, cardNonce: pending.nonce });
            if (pending.turnId) Object.assign(b, { cardAttemptId: cardId, cardAttemptAt: this.now() });
            if (pending.previousCardId && pending.previousCardId !== cardId) {
              b.retiredCardId = pending.previousCardId; b.retiredCardAt = pending.previousCardAt;
            }
          }
        });
        await this.retireCard(binding);
      } catch (error) {
        state.cardFailures = (state.cardFailures ?? 0) + 1;
        state.cardRetryAt = this.now() + Math.min(30000, 1000 * 2 ** (state.cardFailures - 1));
        throw error;
      }
      state.cardFailures = 0; state.cardRetryAt = 0;
      state.lastCard = this.now(); state.signature = pending.signature; state.blockedNotice = false;
      state.forceTurnCard = false;
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
      if (state.transcriptSource) {
        try { batch = await this.transcriptBatch(binding); }
        catch (error) {
          if (['binding_unverified', 'binding_changed'].includes(error.code)) throw error;
          state.failedTranscript = state.transcriptSource.path;
          state.transcriptRetryAt = this.now() + 5000; state.transcriptSource = null;
          this.onError('transcript_unavailable');
          return this.flush(binding);
        }
        if (!batch) {
          await this.settleTurn(binding); return;
        }
      } else {
        if (!state.pending && !state.settle) return;
        if (state.agent && !['idle', 'done'].includes(state.status)) return;
        if (!state.settle && this.now() - state.lastChange < 1500) return;
        batch = { generation: binding.generation ?? 0, checkpoint: state.current, next: 0, chunks: [] };
        const output = stripChrome(newOutput(state.previous, state.current));
        if (output.trim()) batch.chunks.push({ card: state.agent ? assistantCard(output, [], this.agentName(state.agent)) : outputCard(output), uuid: randomUUID() });
      }
      const prepared = batch;
      if (!await this.store.transaction(data => {
        const b = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
        if (!this.sameGeneration(binding, b)) return false;
        b.outputBatch = prepared;
        b.sentInputs = (b.sentInputs ?? []).filter(item => !(prepared.consumedInputs ?? []).includes(item.id));
        return true;
      })) return;
    }
    while (batch.next < batch.chunks.length) {
      if (!this.sameGeneration(binding, this.store.binding(binding.chatId, binding.topicId))) return;
      const chunk = batch.chunks[batch.next];
      if (chunk.turn) {
        const published = await this.enqueue(() => this.publishTurn(binding, chunk.turn), `card:${binding.topicId}`);
        if (!published) return;
        batch.next++;
        if (!await this.updateGeneration(binding, { outputBatch: batch })) return;
        continue;
      }
      // Feishu deduplicates UUIDs for one hour. Stop ambiguous retries before
      // that expires instead of risking another copy after a long outage.
      if (chunk.attemptAt !== undefined && this.now() - chunk.attemptAt >= 55 * 60 * 1000)
        throw Object.assign(new Error('Output retry window expired; inspect delivery'), { code: 'output_retry_expired' });
      if (chunk.attemptAt === undefined) {
        chunk.attemptAt = this.now();
        if (!await this.updateGeneration(binding, { outputBatch: batch })) return;
      }
      await this.verify(binding);
      await this.feishu.reply(binding.topicId, chunk.card ?? chunk.text, chunk.card ? 'interactive' : 'text', chunk.uuid);
      batch.next++;
      if (!await this.updateGeneration(binding, { outputBatch: batch })) return;
    }
    if (!await this.updateGeneration(binding, { lastTranscript: batch.checkpoint, outputBatch: null,
      ...(batch.transcript ? { transcript: batch.transcript } : {}) })) return;
    state.previous = batch.checkpoint; state.pending = state.current !== batch.checkpoint; state.settle = false;
  }
  async publishTurn(binding, turn) {
    let current = this.store.binding(binding.chatId, binding.topicId);
    if (!this.sameGeneration(binding, current) || current.frozen) return false;
    if (current.pendingCard) {
      await this.publishCard(current);
      current = this.store.binding(binding.chatId, binding.topicId);
      if (!this.sameGeneration(binding, current) || current.pendingCard) return false;
    }
    const signature = turnSignature(turn);
    if (current.turn?.id !== turn.id || turnSignature(current.turn) !== signature) {
      if (!await this.updateGeneration(binding, { turn })) return false;
    }
    await this.publishCard(this.store.binding(binding.chatId, binding.topicId));
    current = this.store.binding(binding.chatId, binding.topicId);
    return this.sameGeneration(binding, current) && !current.pendingCard &&
      current.cardTurnId === turn.id && current.cardSignature === turnSignature(current.turn);
  }
  async settleTurn(binding) {
    const current = this.store.binding(binding.chatId, binding.topicId), state = this.state(binding);
    if (!this.sameGeneration(binding, current) || !current.turn || current.turn.settled) return;
    if ((['idle', 'done'].includes(state.status) && (current.turn.hasOutput || current.turn.activeObserved)) ||
      current.turn.path !== state.transcriptSource?.path) {
      await this.updateGeneration(binding, { turn: { ...current.turn, settled: true, status: 'idle' } });
    }
  }
}
