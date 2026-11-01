import { randomUUID, createHash } from 'node:crypto';
import { route, validKeys } from './router.js';
import { clean, screenCard, newOutput, splitText } from './render.js';
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
    for (const b of this.store.list()) this.state(b);
    this.resubscribe();
    await this.feishu.start(event => this.handle(event), this.onError);
    if (timers) this.timer = setInterval(() => { this.tick().catch(() => {}); }, 250);
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.unsubscribe?.();
    this.feishu.close(); this.herdr.close(); await this.queue;
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
    }, () => { for (const state of this.runtime.values()) state.dirty = true; });
  }
  status(state, status, agent = state.agent) {
    if (state.status === 'working' && ['idle', 'done'].includes(status)) state.settle = true;
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
        await this.store.bind({ chatId: event.chatId, topicId: event.messageId, paneId: pane.pane_id });
        this.resubscribe();
        const created = this.store.binding(event.chatId, event.messageId);
        await this.log(event, created, 'first_input', action.text);
        await this.input(created, action.text);
        return;
      }
      if (action.type === 'close') {
        if (action.kill) await this.herdr.request('pane.close', { pane_id: binding.paneId });
        await this.store.unbind(binding.chatId, binding.topicId); this.runtime.delete(binding.topicId); this.resubscribe();
        await this.feishu.reply(binding.topicId, action.kill ? 'Pane closed; topic unbound.' : 'Topic unbound; pane is still running.');
        return;
      }
      if (action.type === 'screen') { this.state(binding).dirty = true; await this.refresh(binding, true); return; }
      if (action.type === 'keys') await this.herdr.request('pane.send_keys', { pane_id: binding.paneId, keys: action.keys });
      if (action.type === 'raw') await this.herdr.request('pane.send_text', { pane_id: binding.paneId, text: action.text });
      if (action.type === 'input') await this.input(binding, action.text);
      this.state(binding).dirty = true;
    } catch (error) {
      // Never echo upstream error messages: they may contain terminal content.
      const code = /^[a-z_0-9]+$/i.test(String(error.code)) ? String(error.code) : 'operation_failed';
      await this.feishu.reply(event.topicId, `Request failed (${code}); input was not retried. Use /t screen or /t ls to inspect.`);
    }
  }
  log(event, binding, action, text = '') {
    return this.audit(auditRecord({ openId: event.openId, topicId: binding?.topicId ?? event.topicId, paneId: binding?.paneId, action, text }));
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
    if (existing) { await this.feishu.reply(event.topicId, `Already bound to topic ${existing.topicId}.`); return; }
    const { pane } = await this.herdr.request('pane.get', { pane_id: paneId });
    if (!pane?.pane_id) throw new Error('Missing pane');
    // A fresh top-level bot post is a topic root, even when /t open was a reply.
    const topicId = await this.feishu.send(event.chatId, `Terminal ${paneId}. Reply here to send input. /t screen shows the terminal.`);
    await this.store.bind({ chatId: event.chatId, topicId, paneId });
    this.resubscribe(); this.state(this.store.binding(event.chatId, topicId));
  }
  async input(binding, text) {
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
      await this.herdr.request('pane.send_text', { pane_id: binding.paneId, text });
      await this.herdr.request('pane.send_keys', { pane_id: binding.paneId, keys: ['enter'] });
    }
    state.dirty = true;
  }
  async button(event, binding) {
    if (!binding || !binding.cardId || event.messageId !== binding.cardId || event.nonce !== binding.nonce ||
      (event.key !== 'refresh' && !validKeys([event.key]))) {
      await this.feishu.reply(event.topicId || event.messageId, 'Stale or foreign card. Use /t screen for the current card.'); return;
    }
    const state = this.state(binding);
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
    if (event.key !== 'refresh') await this.herdr.request('pane.send_keys', { pane_id: binding.paneId, keys: [event.key] });
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
    if (!state.pending && !state.settle) return;
    if (!state.settle && (state.agent || this.now() - state.lastChange < 1500)) return;
    // Content is authoritative; revision can change for cursor/status updates.
    const delta = newOutput(state.previous, state.current);
    for (const [index, part] of splitText(delta).entries()) {
      const uuid = createHash('sha256').update(`${binding.topicId}\0${state.previous}\0${state.current}\0${index}`).digest('hex').slice(0, 32);
      await this.feishu.reply(binding.topicId, part, 'text', uuid);
    }
    await this.store.update(binding.chatId, binding.topicId, { lastTranscript: state.current });
    state.previous = state.current; state.pending = false; state.settle = false;
  }
}
