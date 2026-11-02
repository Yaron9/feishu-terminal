import { cardVersion, renderSchema, patchStoredCard, retirementCard } from './card-schema.js';
import { backgroundView, screenActivity } from './transcripts/background.js';
import { randomUUID, createHash } from 'node:crypto';
import { route, validKeys } from './router.js';
import { clean, screenCard, screenText, newOutput, splitText, stripChrome, assistantCard, outputCard, turnCard, menuCard } from './render.js';
import { turnChunks, turnSignature, freshTurn } from './turns.js';
import { transcriptAdapters } from './transcripts/index.js';
import { bridgeBackend } from './backends/index.js';
import { SessionFollow } from './session-follow.js';
import { auditRecord, appendAudit } from './store.js';
import { cleanTitle, topicCard, topicTitle } from './topics.js';
import { paneLabel } from './panes.js';
import { PanePicker } from './picker.js';
import { detectMenu, sameMenu, resumeWarnings, menuControls, menuPageSize } from './menus.js';

const menuScreenHash = (menu, text) => menu.kind === 'list' && !menu.items.length ?
  createHash('sha256').update(clean(text)).digest('hex') : null;

export class Bridge {
  constructor({ backend, herdr, feishu, store, config, now = Date.now, audit, onError = () => {}, adapters = transcriptAdapters(), sessionFollow }) {
    Object.assign(this, { herdr, feishu, store, config, now, onError });
    this.backend = bridgeBackend(backend, herdr, onError);
    this.sessionFollow = sessionFollow ?? new SessionFollow();
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
    this.starting = true;
    await this.scanSessions();
    for (const b of this.store.list()) {
      this.state(b);
      if (b.chatId === this.chatId) await this.verify(b).catch(() => {});
      if (b.chatId === this.chatId && this.state(b).verified)
        await this.initializeTranscript(b).catch(() => this.onError('transcript_unavailable'));
      if (b.chatId === this.chatId && !this.store.binding(b.chatId, b.topicId).frozen && (b.pendingCard || b.retiredCardId))
        await this.refreshCard(b).catch(() => this.onError('card_refresh_failed'));
    }
    this.starting = false;
    this.resubscribe();
    await this.feishu.start(event => this.accept(event), this.onError);
    if (timers) this.timer = setInterval(() => { this.tick().catch(() => {}); }, 250);
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.unsubscribe?.();
    this.feishu.close(); await this.queue; this.backend.dispose();
  }
  resubscribe() {
    if (this.starting) return;
    this.unsubscribe?.();
    const panes = this.store.list().filter(b => b.chatId === this.chatId && !b.frozen && this.state(b).verified).map(b => b.paneId);
    if (panes.length) this.unsubscribe = this.backend.subscribe(panes, event => {
      const data = event.data ?? {};
      const binding = this.store.forPane(data.pane_id ?? data.pane?.pane_id);
      if (!binding || binding.chatId !== this.chatId || binding.frozen || !this.state(binding).verified) return;
      this.enqueue(async () => {
        const state = this.state(binding); state.dirty = true;
        if (data.agent_status) this.status(state, data.agent_status, data.agent);
      }, binding.topicId).catch(() => {});
    }, (connection, affected = panes) => {
      if (connection === 'disconnected') {
        for (const b of this.store.list().filter(b => affected.includes(b.paneId))) {
          const state = this.state(b); state.dirty = true; state.status = 'unknown'; state.verified = false;
        }
      } else if (connection === 'connected') {
        this.enqueue(async () => {
          for (const b of this.store.list().filter(b => affected.includes(b.paneId) && !b.frozen && !this.state(b).verified)) await this.verify(b).catch(() => {});
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
  rememberCard(id, card, kind) {
    return this.store.transaction(data => {
      (data.cardSchemas ??= {})[id] = { schemaVersion: cardVersion(card), kind };
    });
  }
  patchCard(id, card, kind) { return patchStoredCard(this, id, card, kind); }
  async claimEvent(event) {
    if (event.kind === 'button') this.onError('card_action_received ' + JSON.stringify({
      kind: 'button', topic: typeof event.topicId === 'string' ? event.topicId : null,
      cardId: typeof event.messageId === 'string' ? event.messageId : null }));
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
      if (event.topicId && event.kind === 'message') await this.feishu.reply(event.topicId, '你还没有控制权限，请联系配置此机器人的人。');
      else await this.feishu.send(event.chatId, '你还没有控制权限，请联系配置此机器人的人。');
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
      if (await this.pointToTopic(event)) return;
      const action = route(event.text, Boolean(binding));
      await this.log(event, binding, action.type, event.text ?? '');
      if (action.type === 'error') { await this.feishu.reply(event.topicId, action.message); return; }
      if (action.type === 'list') { await this.list(event); return; }
      if (action.type === 'closePicker') { await this.picker.show(event, binding); return; }
      if (action.type === 'open') { await this.open(event, action.paneId); return; }
      if (action.type === 'move') { await this.move(event, action.paneId ?? binding.paneId); return; }
      if (action.type === 'create') {
        if (event.isReply) { await this.feishu.reply(event.topicId, '这个话题还没有连接终端。请发送 /t ls，点 [打开] 进入终端话题。'); return; }
        await this.createTopic(event, action);
        return;
      }
      if (action.type === 'close') {
        if (action.kill) {
          await this.verify(binding);
          const panes = await this.backend.list();
          if (!panes.some(p => p.pane_id === binding.paneId && p.terminal_id === binding.identity.terminalId))
            throw Object.assign(new Error('Binding unverified'), { code: 'binding_unverified' });
          await this.backend.close(binding.paneId);
        }
        await this.store.unbind(binding.chatId, binding.topicId); this.runtime.delete(binding.topicId); this.resubscribe();
        await this.feishu.reply(binding.topicId, action.kill ? '终端已关闭，话题已停止同步。' : '话题已停止同步，终端仍在 VPS 上运行。');
        return;
      }
      if (action.type === 'screen') {
        this.state(binding).dirty = true; await this.refresh(binding, true);
        const { read } = await this.readVerified(binding, () => this.backend.read(binding.paneId, { source: 'visible' }));
        for (const part of splitText(clean(read.text), 4000)) {
          await this.verify(binding);
          await this.feishu.reply(binding.topicId, outputCard(part, { full: true }), 'interactive');
        }
        return;
      }
      if (action.type === 'ok') {
        await this.verify(binding);
        await this.store.update(binding.chatId, binding.topicId, { needs_check: false });
        await this.feishu.reply(binding.topicId, '已确认检查过屏幕，可以继续输入。'); return;
      }
      if (action.type === 'keys') await this.writeInput(binding, 'keys', { keys: action.keys }, action.keys.length === 1 && action.keys[0] === 'ctrl+u');
      if (action.type === 'raw') await this.writeInput(binding, 'text', { text: action.text });
      if (action.type === 'input') await this.input(binding, action.text);
      this.state(binding).dirty = true;
    } catch (error) {
      if (error.code === 'binding_unverified') {
        await this.feishu.reply(event.topicId, '终端已变化（可能重启或迁移过），已暂停同步。发送 /t ls，点 [打开] 重新绑定'); return;
      }
      if (this.store.binding(event.chatId, event.topicId)?.needs_check) {
        let screen = '[暂时无法读取屏幕，请发送 /t screen 查看]';
        try { screen = screenText((await this.readVerified(binding, () => this.backend.read(binding.paneId, { source: 'visible', lines: 40 }))).read.text); } catch {}
        await this.feishu.reply(event.topicId, `请先检查输入是否成功，系统没有重复发送。查看下方屏幕；如需清空当前输入行，发送 /t k ctrl+u；确认后发送 /t ok，再继续输入。\n${screen}`); return;
      }
      // Never echo upstream error messages: they may contain terminal content.
      const code = /^[a-z_0-9]+$/i.test(String(error.code)) ? String(error.code) : 'operation_failed';
      await this.feishu.reply(event.topicId, `操作未完成（${code}），系统没有重复发送输入。请发送 /t screen 查看屏幕，或 /t ls 查看终端。`);
    }
  }
  async createTopic(event, action) {
    // Resuming a bound session is a migration request. Start the command in
    // the selected backend without creating a competing topic/binding; the
    // verified process scan will move the original topic once Claude runs.
    const resume = /(?:^|&&\s*)claude\s+--resume(?:=|\s+)(?:"([a-zA-Z0-9_-]+)"|'([a-zA-Z0-9_-]+)'|([a-zA-Z0-9_-]+))(?=\s|$)/u.exec(action.text);
    const sessionId = resume && (resume[1] ?? resume[2] ?? resume[3]);
    const original = this.config.sessionFollow !== 'warn' && sessionId &&
      this.store.list().find(b => b.chatId === event.chatId && b.claudeSessionId === sessionId);
    if (original) {
      await this.log(event, original, 'session_resume_input', action.text);
      const pane = await this.backend.create(action.text, this.config.defaultCwd);
      await this.store.transaction(data => {
        (data.createdTerminals ??= []).push(pane.terminal_id);
        (data.topicPointers ??= []).push({ chatId: event.chatId, oldTopicId: event.messageId,
          topicId: original.topicId, title: original.topicRoot?.text ?? original.topicId });
      });
      await this.pointToTopic(event); return;
    }
    const pane = await this.createPane();
    const identity = await this.identity(pane.pane_id);
    const root = this.newRoot(pane, action.text);
    const topicId = await this.feishu.send(event.chatId, root.card);
    await this.rememberCard(topicId, root.card, 'root');
    await this.store.bind({ chatId: event.chatId, topicId, paneId: pane.pane_id, identity, topicRoot: root.metadata });
    const created = this.store.binding(event.chatId, topicId);
    await this.store.transaction(data => {
      (data.topicPointers ??= []).push({ chatId: event.chatId, oldTopicId: event.messageId, topicId, title: root.metadata.text });
    });
    await this.verify(created); this.resubscribe();
    try {
      await this.log(event, created, 'first_input', action.text);
      await this.input(created, action.text);
    } finally {
      // Setup normally assigns the operator as owner; claim setup omits owner_id.
      // Official DELETE docs (230026) restrict bots to their own messages,
      // so creator/owner status is not sufficient to recall this user message.
      await this.pointToTopic(event).catch(() => {});
    }
  }
  async pointToTopic(event) {
    const pointer = this.store.data.topicPointers?.find(p => p.chatId === event.chatId && p.oldTopicId === event.topicId);
    if (!pointer) return false;
    const title = this.store.binding(pointer.chatId, pointer.topicId)?.topicRoot?.text ?? pointer.title;
    await this.feishu.reply(event.topicId, `已在新话题「${title}」打开，请到那里继续`);
    return true;
  }
  newRoot(pane, fallback) {
    const title = topicTitle(pane, fallback), card = topicCard(pane, title);
    return { card, metadata: { schemaVersion: cardVersion(card), type: 'interactive', text: title, publishedTitle: title,
      createdAt: this.now(), lastAttemptAt: null, stopped: false } };
  }
  async syncTopicTitle(binding, pane) {
    const root = this.store.binding(binding.chatId, binding.topicId)?.topicRoot;
    // Legacy roots have unknown sender, edit count and administrator edit window.
    // Never infer edit eligibility from a text prefix or migrate their type.
    if (root?.type !== 'interactive' || root.stopped) return;
    const state = this.state(binding), now = this.now();
    if (now - root.createdAt >= 14 * 86400000) {
      await this.updateGeneration(binding, { topicRoot: { ...root, stopped: true } }); return;
    }
    if (pane.terminal_title_stripped?.trim() && !cleanTitle(pane.terminal_title_stripped)) {
      state.titleCandidate = null; return;
    }
    const title = topicTitle(pane);
    if (state.titleCandidate !== title) { state.titleCandidate = title; state.titleSince = now; }
    if (title === root.publishedTitle || now - state.titleSince < 10000 ||
        (root.lastAttemptAt !== null && now - root.lastAttemptAt < 60000)) return;
    await this.verify(binding);
    const attempted = { ...root, lastAttemptAt: now };
    await this.updateGeneration(binding, { topicRoot: attempted });
    try {
      await this.patchCard(binding.topicId, topicCard(pane, title), 'root');
      await this.updateGeneration(binding, { topicRoot: { ...attempted, text: title, publishedTitle: title } });
    } catch (error) {
      if (['230031', '230011', '230110'].includes(String(error.code)))
        await this.updateGeneration(binding, { topicRoot: { ...attempted, stopped: true } });
      else this.onError('topic_title_update_failed');
    }
  }
  log(event, binding, action, text = '') {
    return this.audit(auditRecord({ openId: event.openId, topicId: binding?.topicId ?? event.topicId, paneId: binding?.paneId, action, text }));
  }
  async identity(paneId, allowDesktop = false) {
    const pane = await this.backend.get(paneId, { allowDesktop });
    return this.backend.identity(pane);
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
    } catch (error) {
      if (['connection_error', 'connection_closed', 'timeout', 'backend_unavailable'].includes(error.code)) {
        this.state(binding).verified = false;
        throw error;
      }
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
    if (method === 'text') {
      await this.initializeTranscript(binding);
      await this.rememberInput(binding, params.text);
    }
    await (method === 'text' ? this.backend.sendText(binding.paneId, params.text) : this.backend.sendKeys(binding.paneId, params.keys));
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
      if (!pane) pane = await this.readVerified(binding, () => this.backend.get(binding.paneId));
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
        const patch = { transcript: { adapter: key, path, cursor, lastRecordAt: this.now() } };
        if (!current.turn && cursor.background?.running?.length) {
          patch.turn = freshTurn({ key, path }, this.agentName(key), state.status);
          if (['idle', 'done'].includes(state.status)) { patch.turn.settled = true; patch.turn.status = 'idle'; }
        }
        if (!await this.updateGeneration(binding, patch)) return;
      }
      if (current.transcript?.path === path && current.transcript.lastRecordAt == null)
        await this.updateGeneration(binding, { transcript: { ...current.transcript, lastRecordAt: this.now() } });
      state.transcriptSource = { key, path, adapter };
      const session = adapter.sessions?.get(path);
      if (key === 'claude' && session?.sessionId && current.claudeSessionId !== session.sessionId)
        await this.updateGeneration(binding, { claudeSessionId: session.sessionId, sessionHandoff: null });
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
    if (!current.turn && !chunks.some(chunk => chunk.turn) && cursor.background?.running?.length) {
      const turn = freshTurn(source, this.agentName(source.key), state.status);
      if (['idle', 'done'].includes(state.status)) { turn.settled = true; turn.status = 'idle'; }
      chunks.push({ turn });
    }
    return { generation: binding.generation ?? 0, checkpoint: state.current, next: 0, chunks, consumedInputs,
      transcript: { adapter: source.key, path: source.path, cursor,
        lastRecordAt: cursor.offset !== checkpoint.cursor.offset ? this.now() : checkpoint.lastRecordAt ?? this.now() } };
  }
  async createPane() {
    return this.enqueue(() => this.createPaneSerial(), 'pane-create');
  }
  async createPaneSerial() {
    const pane = await this.backend.create(null, this.config.defaultCwd);
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
        claudeSessionId: null, sessionHandoff: null,
        lastTranscript: undefined, transcript: null, turn: null, cardTurnId: null, cardSignature: null,
        cardMenu: null, cardMenuScreenHash: null, menuConfirm: null, menuPage: 0,
        menuCardId: null, menuNonce: null, pendingMenuCard: null, menuSelected: null, menuSignature: null,
        sentInputs: [], nonce: randomUUID(), pendingCard: null, outputBatch: null, discardedOutput: false });
      this.runtime.delete(existing.topicId);
      await this.verify(this.store.binding(existing.chatId, existing.topicId)); this.resubscribe();
      if (existing.outputBatch || existing.discardedOutput) await this.feishu.reply(existing.topicId, '旧终端未发送完的输出已丢弃');
      await this.feishu.reply(existing.topicId, '已重新绑定到当前终端');
      return this.recoverOpen(event, this.store.binding(existing.chatId, existing.topicId), expectedTerminalId);
    }
    // A fresh top-level bot post is a topic root, even when /t open was a reply.
    const panes = await this.backend.list();
    const pane = panes.find(p => p.pane_id === paneId && p.terminal_id === identity.terminalId);
    if (!pane) throw new Error('Unconfirmed pane identity');
    const root = this.newRoot(pane);
    const topicId = await this.feishu.send(event.chatId, root.card);
    await this.rememberCard(topicId, root.card, 'root');
    await this.store.bind({ chatId: event.chatId, topicId, paneId, identity, topicRoot: root.metadata,
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
          const panes = await this.backend.list();
          const pane = panes.find(p => p.pane_id === paneId && p.terminal_id === binding.identity.terminalId);
          if (!pane) throw new Error('终端已变化，请重新 /t ls');
          const root = this.newRoot(pane), text = root.metadata.text;
          await this.verify(binding);
          const topicId = await this.feishu.send(event.chatId, root.card);
          await this.rememberCard(topicId, root.card, 'root');
          await this.verify(binding);
          const moved = await this.store.transaction(data => {
            const current = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
            if (!this.sameGeneration(binding, current) || current.frozen) throw new Error('终端已变化，请重新 /t ls');
            Object.assign(current, { topicId, generation: randomUUID(), nonce: randomUUID(), cardId: null,
              cardCreatedAt: null, cardTurnId: null, cardSignature: null, pendingCard: null,
              cardMenu: null, cardMenuScreenHash: null, menuConfirm: null, menuPage: 0,
              menuCardId: null, menuNonce: null, pendingMenuCard: null, menuSelected: null, menuSignature: null,
              retiredCardId: undefined, retiredCardKind: undefined, retiredCardAt: undefined, retiredCardAttempts: undefined, outputBatch: null,
              topicRoot: root.metadata });
            for (const pointer of data.topicPointers ?? []) {
              if (pointer.chatId === binding.chatId && pointer.topicId === binding.topicId)
                Object.assign(pointer, { topicId, title: text });
            }
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
      if (this.state(binding).menu?.kind) {
        await this.publishCard(current, true);
        return this.state(binding).menu.title;
      }
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
      const { read } = await this.readVerified(binding, () => this.backend.read(binding.paneId,
        state.transcriptSource ? { source: 'visible' } : {}));
      if (binding.lastTranscript === undefined) {
        state.previous = clean(read.text); state.current = state.previous;
        await this.store.update(binding.chatId, binding.topicId, { lastTranscript: state.previous });
      }
      state.initialized = true;
    }
    const agent = (await this.backend.list()).find(p => p.pane_id === binding.paneId);
    this.status(state, agent ? this.backend.status(agent, state.visible) : 'unknown', agent?.agent ?? null);
    const inputId = await this.rememberInput(binding, text);
    await this.store.update(binding.chatId, binding.topicId, { needs_check: true });
    try {
      await this.backend.sendText(binding.paneId, text, { submit: true, beforeSubmit: () => this.verify(binding) });
      await this.updateGeneration(binding, { needs_check: false });
    } catch (error) {
      if (!['agent_blocked', 'blocked'].includes(error.code)) throw error;
      await this.updateGeneration(binding, { needs_check: false });
      await this.store.transaction(data => {
        const b = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
        if (this.sameGeneration(binding, b)) b.sentInputs = (b.sentInputs ?? []).filter(item => item.id !== inputId);
      });
      this.status(state, 'blocked', agent?.agent); state.dirty = true;
      await this.refresh(binding, true, true); return;
    }
    state.dirty = true;
  }
  async button(event, binding) {
    if (/^picker:(?:open|move|close|unbind|kill|cancel):\d+$/.test(event.key ?? '')) { await this.picker.button(event); return; }
    if (event.key !== 'refresh' && !validKeys([event.key]) && !/^menu:(?:select:\d+|confirm:\d+|more|back)$/.test(event.key ?? '')) {
      await this.feishu.reply(event.topicId || event.messageId, '该按钮已停用'); return;
    }
    const isMenu = Boolean(binding?.menuCardId && event.messageId === binding.menuCardId);
    if (binding?.menuCardId && !isMenu && event.key !== 'refresh') {
      await this.feishu.reply(binding.topicId, '菜单已变化，请刷新'); return;
    }
    if (isMenu) binding = { ...binding, cardId: binding.menuCardId, nonce: binding.menuNonce, cardCreatedAt: binding.menuCreatedAt };
    else if (binding) binding = { ...binding, cardMenu: null };
    const menuAction = /^menu:(?:select:\d+|confirm:\d+|more|back)$/.test(event.key ?? '');
    if (!binding || !binding.cardId || event.messageId !== binding.cardId || event.nonce !== binding.nonce ||
      (event.key !== 'refresh' && !validKeys([event.key]) && !menuAction)) {
      await this.feishu.reply(event.topicId || event.messageId, '这张卡片已失效或属于其他话题，请发送 /t screen 获取当前卡片。'); return;
    }
    const state = this.state(binding);
    if (!Number.isFinite(binding.cardCreatedAt) || this.now() - binding.cardCreatedAt >= 600000 || this.now() < binding.cardCreatedAt) {
      await this.feishu.reply(event.topicId, '卡片已过期，请重新 /t screen'); return;
    }
    try { await this.verify(binding); }
    catch { await this.feishu.reply(event.topicId, '终端已变化，请重新 /t ls'); return; }
    if (menuAction && binding.cardMenu?.kind !== 'list') {
      await this.feishu.reply(binding.topicId, '菜单已变化，请刷新'); return;
    }
    if (binding.cardMenu?.kind === 'numbered' && !['esc', 'refresh',
      ...binding.cardMenu.items.map((_, i) => String(i + 1))].includes(event.key)) {
      await this.feishu.reply(binding.topicId, '菜单已变化，请刷新'); return;
    }
    if (binding.cardMenu?.kind === 'list' && !menuControls(binding.cardMenu, {
      page: binding.menuPage, confirm: binding.menuConfirm, pageSize: binding.menuPageSize,
    }).some(([, key]) => key === event.key)) {
      await this.feishu.reply(binding.topicId, '菜单已变化，请刷新'); return;
    }
    if (event.key !== 'refresh' && !binding.cardMenu?.kind) {
      const agents = await this.backend.list();
      if (!agents.some(a => a.pane_id === binding.paneId && this.backend.status(a, state.visible) === 'blocked')) {
        await this.feishu.reply(binding.topicId, '终端已经不在等待确认，请发送 /t screen 查看当前状态。'); return;
      }
    }
    // Consume the nonce durably before sending any key. A replay under a new
    // event_id cannot execute the same card action again, including on restart.
    if (!await this.store.consumeCard(binding.chatId, binding.topicId, event.messageId, event.nonce, isMenu)) {
      await this.feishu.reply(binding.topicId, '这张卡片已操作过，请发送 /t screen 获取当前卡片。'); return;
    }
    await this.log(event, binding, event.key === 'refresh' ? 'refresh' : 'button_key', event.key);
    if (event.key !== 'refresh') {
      if (binding.cardMenu?.kind) {
        await this.menuButton(event, binding);
      } else await this.writeInput(binding, 'keys', { keys: [event.key] });
    }
    state.dirty = true; await this.refresh(this.store.binding(binding.chatId, binding.topicId), true);
  }
  async menuButton(event, binding) {
    const { read } = await this.readVerified(binding, () => this.backend.read(binding.paneId, { source: 'visible' }));
    const menu = detectMenu(read.text);
    if (!sameMenu(binding.cardMenu, menu) || (binding.cardMenuScreenHash ?? null) !== menuScreenHash(menu, read.text)) {
      await this.updateGeneration(binding, { menuConfirm: null, menuPage: 0 });
      await this.feishu.reply(binding.topicId, '菜单已变化，请刷新'); return;
    }
    if (event.key === 'menu:more' || event.key === 'menu:back') {
      await this.updateGeneration(binding, { menuConfirm: null,
        menuPage: event.key === 'menu:more' ? ((binding.menuPage ?? 0) + 1) % Math.ceil(menu.items.length / (binding.menuPageSize ?? menuPageSize(menu))) : binding.menuPage ?? 0 });
      return;
    }
    const selection = /^menu:(select|confirm):(\d+)$/.exec(event.key);
    const fallbackSelection = menu.kind === 'list' && !menu.items.length && (event.key === 'enter' || selection);
    let keys = [event.key];
    if (selection || fallbackSelection) {
      const index = selection ? Number(selection[2]) : 0;
      const panes = await this.backend.list();
      const warnings = resumeWarnings(menu, panes, binding.paneId, read.text)[index];
      if (warnings?.length && (selection?.[1] !== 'confirm' || binding.menuConfirm?.index !== index ||
          !sameMenu(binding.menuConfirm?.menu, menu) || JSON.stringify(binding.menuConfirm?.warnings) !== JSON.stringify(warnings))) {
        await this.updateGeneration(binding, { menuConfirm: { menu, index, warnings } }); return;
      }
      const delta = index - menu.cursorIndex;
      keys = fallbackSelection ? ['enter'] : [...Array(Math.abs(delta)).fill(delta > 0 ? 'down' : 'up'), 'enter'];
    }
    // Recheck after durable nonce consumption, auditing and duplicate lookup.
    // No movement or Enter is sent for a stale item/cursor/title snapshot.
    const fresh = await this.readVerified(binding, () => this.backend.read(binding.paneId, { source: 'visible' }));
    if (!sameMenu(menu, detectMenu(fresh.read.text)) || menuScreenHash(menu, read.text) !== menuScreenHash(menu, fresh.read.text)) {
      await this.updateGeneration(binding, { menuConfirm: null, menuPage: 0 });
      await this.feishu.reply(binding.topicId, '菜单已变化，请刷新'); return;
    }
    await this.updateGeneration(binding, { menuConfirm: null, menuPage: 0 });
    await this.writeInput(binding, 'keys', { keys });
    const selected = selection ? menu.items[Number(selection[2])]?.label :
      menu.kind === 'numbered' && /^[1-9]$/.test(event.key) ? menu.items[Number(event.key) - 1]?.label :
      event.key === 'enter' ? menu.items[menu.cursorIndex]?.label : null;
    await this.updateGeneration(binding, { menuSelected: selected ?? null });
  }
  tick() {
    if (this.tickPending || this.stopped) return Promise.resolve();
    this.tickPending = true;
    return this.scanSessions().then(() => Promise.all(this.store.list().filter(b => b.chatId === this.chatId && !b.frozen && this.state(b).verified).map(binding =>
      this.enqueue(async () => {
        if (!this.store.binding(binding.chatId, binding.topicId)) return;
        const state = this.state(binding);
        try {
          if (state.dirty || this.now() - state.lastRead >= 1000) await this.refresh(binding, false, false, true);
        } catch { this.onError('output_refresh_failed'); }
        try { await this.flush(binding); } catch { this.onError('output_flush_failed'); }
        try { await this.refreshCard(binding); } catch { this.onError('card_refresh_failed'); }
      }, `output:${binding.topicId}`)
    ))).finally(() => { this.tickPending = false; });
  }
  async scanSessions() {
    if (this.now() - (this.lastSessionScan ?? -Infinity) < 1000) return;
    this.lastSessionScan = this.now();
    for (const snapshot of this.store.list().filter(b => b.chatId === this.chatId)) {
      // Input, output and card work all drain before the atomic retarget.
      await this.enqueue(() => this.enqueue(() => this.enqueue(async () => {
        let binding = this.store.binding(snapshot.chatId, snapshot.topicId);
        if (!binding) return;
        if (this.config.sessionFollow === 'warn') return;
        if (binding.sessionHandoff && !binding.sessionHandoff.done) {
          await this.finishHandoff(binding); return;
        }
        if (!binding.claudeSessionId && binding.transcript?.adapter === 'claude') {
          const sessionId = await this.sessionFollow.sessionIdOf(binding.transcript.cursor?.pid);
          if (sessionId) {
            await this.updateGeneration(binding, { claudeSessionId: sessionId });
            binding = this.store.binding(binding.chatId, binding.topicId);
          }
        }
        if (binding.claudeSessionId && !binding.frozen && this.state(binding).verified) {
          // /clear and /resume can replace the session in the same terminal.
          // Refresh that fact before following a previously stored session ID.
          const term = await this.backend.get(binding.paneId).catch(() => null);
          if (term && Object.entries(binding.identity ?? {}).every(([k, v]) => this.backend.identity(term)[k] === v)) {
            const pid = this.backend.processOf(term) ?? binding.transcript?.cursor?.pid;
            const sessionId = await this.sessionFollow.sessionIdOf(pid);
            const active = sessionId && await this.sessionFollow.process(pid, sessionId);
            if (active && active.terminalId === binding.paneId && sessionId !== binding.claudeSessionId) {
              await this.updateGeneration(binding, { claudeSessionId: sessionId, sessionHandoff: null });
              binding = this.store.binding(binding.chatId, binding.topicId);
            }
          }
        }
        if (!binding.claudeSessionId) return;
        const candidates = await this.sessionFollow.candidates(binding.claudeSessionId);
        if (!candidates.length) return;
        const winner = candidates[0], terminals = await this.backend.list();
        const terminal = this.sessionFollow.terminal(winner, terminals, this.backend);
        if (!terminal) return; // Bare ssh: ft24 warning only, no termination.
        if (binding.sessionHandoff?.done && binding.sessionHandoff.winner.pid === winner.pid &&
            binding.sessionHandoff.winner.start === winner.start && terminal.pane_id === binding.paneId) return;
        if (terminal.pane_id === binding.paneId && candidates.length === 1) return;
        if (this.store.forPane(terminal.pane_id)?.topicId && this.store.forPane(terminal.pane_id).topicId !== binding.topicId) {
          this.onError('session_follow_target_bound'); return;
        }
        const identity = await this.identity(terminal.pane_id, true);
        const live = await this.sessionFollow.process(winner.pid, winner.sessionId);
        if (!live || live.start !== winner.start || live.terminalId !== winner.terminalId) return;
        const generation = randomUUID();
        const moved = await this.store.transaction(data => {
          const current = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
          if (!this.sameGeneration(binding, current) || data.bindings.some(b => b !== current && b.paneId === terminal.pane_id)) return null;
          Object.assign(current, { paneId: terminal.pane_id, identity, generation, allowDesktop: true, frozen: false,
            nonce: randomUUID(), menuNonce: randomUUID(), cardMenu: null, menuConfirm: null, menuPage: 0,
            pendingMenuCard: null, menuSignature: null,
            sessionHandoff: { winner, older: candidates.slice(1).map(p => ({ process: p })),
              label: `${terminal.backendLabel ?? ''} ${terminal.pane_id}`, uuid: randomUUID(), createdAt: this.now(), done: false } });
          if (current.outputBatch) current.outputBatch.generation = generation;
          // Keep uncertain delivery's UUID/payload. Its old nonce must never
          // become actionable again when the publication is reconciled.
          if (current.pendingCard) current.pendingCard.staleNonce = true;
          return structuredClone(current);
        });
        if (!moved) return;
        // Keep transcript cursor/turn/card IDs, invalidate every old callback.
        const state = this.state(binding);
        Object.assign(state, { verified: false, dirty: true, initialized: false, lastRead: -Infinity,
          forceTurnCard: true, cardPending: true, menu: null, transcriptSource: null });
        await this.audit({ ...auditRecord({ topicId: binding.topicId, paneId: moved.paneId, action: 'session_retarget' }),
          old_pane: binding.paneId, winner_pid: winner.pid, older_pids: candidates.slice(1).map(p => p.pid) });
        await this.verify(moved); this.resubscribe();
        await this.finishHandoff(moved);
      }, `card:${snapshot.topicId}`), `output:${snapshot.topicId}`), snapshot.topicId).catch(() => this.onError('session_follow_failed'));
    }
    let recovered = false;
    for (const b of this.store.list().filter(b => b.chatId === this.chatId && !b.frozen && !this.state(b).verified)) {
      await this.verify(b).catch(() => {});
      recovered ||= this.state(b).verified;
    }
    if (recovered) this.resubscribe();
  }
  async finishHandoff(binding) {
    let handoff = this.store.binding(binding.chatId, binding.topicId)?.sessionHandoff;
    if (!handoff || handoff.done) return;
    await this.verify(binding);
    for (let i = 0; i < handoff.older.length; i++) {
      if (handoff.older[i].outcome) continue;
      // A crash after this claim cannot resend a signal on restart.
      handoff.older[i].outcome = 'unverified';
      if (!await this.updateGeneration(binding, { sessionHandoff: handoff })) return;
      const result = await this.sessionFollow.terminate(handoff.older[i].process, handoff.winner,
        async record => {
          await this.audit({ ...auditRecord({ topicId: binding.topicId, paneId: binding.paneId, action: record.action }), ...record });
          if (record.action === 'session_terminate_intent') await this.verify(binding);
        },
        () => this.sameGeneration(binding, this.store.binding(binding.chatId, binding.topicId)));
      handoff.older[i].outcome = result.outcome;
      if (!await this.updateGeneration(binding, { sessionHandoff: handoff })) return;
    }
    const remaining = handoff.older.filter(p => p.outcome !== 'ended').map(p => p.process.pid);
    const text = `会话已转到 ${handoff.label}，` + (remaining.length ? `旧进程仍需检查（PID ${remaining.join('、')}），未强制结束` : '旧进程已结束');
    if (this.now() - handoff.createdAt < 55 * 60 * 1000) {
      await this.feishu.reply(binding.topicId, { schema: '2.0', body: { elements: [
        { tag: 'markdown', content: `<font color="grey">${text}</font>` },
      ] } }, 'interactive', handoff.uuid);
    }
    handoff.done = true;
    await this.updateGeneration(binding, { sessionHandoff: handoff });
  }
  async refresh(binding, force = false, forceBlocked = false, deferCard = false) {
    const state = this.state(binding), now = this.now();
    const [{ read: visible }, panes] = await this.readVerified(binding, () => Promise.all([
      this.backend.read(binding.paneId, { source: 'visible' }), this.backend.list(),
    ]));
    const agent = panes.find(p => p.pane_id === binding.paneId);
    this.status(state, forceBlocked ? 'blocked' : agent ? this.backend.status(agent, visible.text) : 'unknown', agent?.agent ?? null);
    state.lastRead = now; state.dirty = false;
    const pane = panes.find(p => p.pane_id === binding.paneId && p.terminal_id === binding.identity.terminalId);
    if (!pane) throw Object.assign(new Error('Binding unverified'), { code: 'binding_unverified' });
    await this.syncTopicTitle(binding, pane);
    await this.initializeTranscript(binding, { ...pane, agent: agent?.agent ?? pane.agent });
    const recent = state.transcriptSource ? visible : (await this.readVerified(binding, () => this.backend.read(binding.paneId))).read;
    if (!state.initialized) {
      if (binding.lastTranscript === undefined) state.previous = clean(recent.text);
      state.initialized = true;
    }
    const content = clean(recent.text);
    if (content !== state.current) { state.current = content; state.lastChange = now; state.pending = true; }
    const menu = detectMenu(visible.text), warnings = resumeWarnings(menu, panes, binding.paneId, visible.text);
    const menuSignature = JSON.stringify({ menu, warnings, screenHash: menuScreenHash(menu, visible.text) });
    if ((binding.menuConfirm || binding.menuPage) && (!sameMenu(binding.cardMenu, menu) ||
        (binding.cardMenuScreenHash ?? null) !== menuScreenHash(menu, visible.text)))
      await this.updateGeneration(binding, { menuConfirm: null, menuPage: 0 });
    const signature = createHash('sha256').update(visible.text + '\0' + state.status + '\0' + this.label(pane) + '\0' + menuSignature).digest('hex');
    state.cardPending = state.cardPending || force || signature !== state.signature || state.blockedNotice;
    if (state.transcriptSource && ((state.status === 'blocked' && state.visible !== visible.text) ||
        ((menu.kind || state.menu?.kind) && menuSignature !== state.menuSignature))) state.forceTurnCard = true;
    state.menu = menu; state.menuSignature = menuSignature;
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
    const panes = await this.backend.list();
    const pane = panes.find(p => p.pane_id === binding.paneId && p.terminal_id === binding.identity.terminalId);
    if (!pane) throw Object.assign(new Error('Binding unverified'), { code: 'binding_unverified' });
    if (this.turnMode(binding) && binding.turn) {
      const turn = binding.turn, newTurn = binding.cardTurnId !== turn.id;
      return { nonce, createdAt: this.now(), targetId: resume || newTurn ? null : binding.cardId ?? null,
        ...((resume || (newTurn && !binding.cardTurnId)) && binding.cardId ? {
          previousCardId: binding.cardId, previousCardKind: binding.cardTurnId ? 'turn' : 'status',
          ...(binding.cardTurnId ? { previousCardAt: binding.cardAttemptAt } : {}),
        } : {}),
        uuid: randomUUID(), turnId: turn.id, signature: turnSignature(turn),
        card: turnCard({ turn, topicId: binding.topicId, nonce, screen: state.menu?.kind ? '' : state.visible, suppressMenu: true, ...(resume ? { note: '📍 已从终端列表恢复' } : {}) }) };
    }
    return { nonce, createdAt: this.now(), targetId: resume ? null : binding.cardId ?? null,
      ...(resume && binding.cardId ? { previousCardId: binding.cardId, previousCardKind: binding.cardTurnId ? 'turn' : 'status' } : {}),
      uuid: randomUUID(), signature: state.nextSignature,
      card: screenCard({ paneId: binding.paneId, label: this.label(pane), topicId: binding.topicId, nonce,
        agent: state.agent, status: state.status, text: state.menu?.kind ? '' : state.visible, suppressMenu: true, ...(resume ? { note: '📍 已从终端列表恢复' } : {}) }) };
  }
  async retireCard(binding) {
    const current = this.store.binding(binding.chatId, binding.topicId);
    if (!this.sameGeneration(binding, current) || !current.retiredCardId) return;
    const state = this.state(binding);
    if (this.now() < (state.retireRetryAt ?? 0)) return;
    if (Number.isFinite(current.retiredCardAt) && this.now() - current.retiredCardAt < 2000) return;
    // Persist the attempt before I/O so rebooting cannot reset the retry budget.
    const attempts = current.retiredCardAttempts ?? 0;
    if (attempts < 3) {
      if (!await this.updateGeneration(current, { retiredCardAttempts: attempts + 1 })) return;
      try {
        await this.patchCard(current.retiredCardId, retirementCard(), current.retiredCardKind);
      } catch (error) {
        const code = String(error.code ?? error.cause?.code ?? '');
        const transient = ['network_error', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
          'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code);
        const retry = transient && attempts + 1 < 3;
        this.onError('card_retirement_failed ' + JSON.stringify({ topic: current.topicId,
          cardId: current.retiredCardId, code, message: error.detail ?? error.message,
          attempt: attempts + 1, disposition: retry ? 'retry' : 'abandoned' }));
        if (retry) {
          state.retireRetryAt = this.now() + 1000 * 2 ** attempts;
          return;
        }
      }
    }
    state.retireRetryAt = 0;
    await this.store.transaction(data => {
      const b = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
      if (this.sameGeneration(binding, b) && b.retiredCardId === current.retiredCardId) {
        delete b.retiredCardId; delete b.retiredCardKind; delete b.retiredCardAt; delete b.retiredCardAttempts;
      }
    });
  }
  async publishMenuCard(binding) {
    const state = this.state(binding), menu = state.menu ?? detectMenu(state.visible);
    if (!menu.kind && !binding.menuCardId && !binding.pendingMenuCard) return;
    const panes = await this.backend.list();
    const warnings = resumeWarnings(menu, panes, binding.paneId, state.visible);
    const pageSize = menuPageSize(menu, warnings);
    const signature = JSON.stringify({ menu, warnings, page: binding.menuPage ?? 0,
      confirm: binding.menuConfirm, selected: binding.menuSelected, hash: menuScreenHash(menu, state.visible) });
    if (!binding.pendingMenuCard && signature === binding.menuSignature && binding.menuNonce === binding.menuPublishedNonce) return;
    if (this.now() < (state.menuRetryAt ?? 0) ||
        binding.menuCardId && this.now() - (binding.menuAttemptAt ?? -Infinity) < 1000) return;
    let pending = binding.pendingMenuCard;
    if (!pending) {
      const nonce = randomUUID();
      pending = { nonce, uuid: randomUUID(), targetId: binding.menuCardId ?? null, createdAt: this.now(),
        signature, menu, pageSize, screenHash: menuScreenHash(menu, state.visible),
        card: menuCard({ menu, topicId: binding.topicId, nonce,
          menuUI: { page: binding.menuPage ?? 0, pageSize, warnings,
            confirm: sameMenu(binding.menuConfirm?.menu, menu) ? binding.menuConfirm : null },
          ...(!menu.kind ? { result: binding.menuSelected ?? '' } : {}) }) };
      if (!await this.updateGeneration(binding, { pendingMenuCard: pending })) return;
    }
    try {
      await this.verify(binding);
      if (!await this.updateGeneration(binding, { menuAttemptAt: this.now() })) return;
      let id = pending.targetId;
      if (id) {
        try { await this.patchCard(id, pending.card, 'menu'); }
        catch (error) {
          if (!['230011', '230031', '230110'].includes(String(error.code))) throw error;
          id = null; pending.targetId = null;
          if (!await this.updateGeneration(binding, { pendingMenuCard: pending })) return;
        }
      }
      if (!id) {
        if (this.now() - pending.createdAt >= 55 * 60 * 1000) throw new Error('Menu retry window expired');
        await this.verify(binding);
        id = await this.feishu.reply(binding.topicId, renderSchema(pending.card, cardVersion(pending.card)), 'interactive', pending.uuid);
        await this.rememberCard(id, pending.card, 'menu');
      }
      await this.updateGeneration(binding, { pendingMenuCard: null,
        menuCardId: pending.menu.kind ? id : null, menuNonce: pending.menu.kind ? pending.nonce : null,
        menuPublishedNonce: pending.menu.kind ? pending.nonce : null, menuCreatedAt: pending.createdAt,
        menuSignature: pending.signature, menuPageSize: pending.pageSize,
        cardMenu: pending.menu.kind ? pending.menu : null, cardMenuScreenHash: pending.screenHash,
        ...(!pending.menu.kind ? { menuSelected: null, menuConfirm: null, menuPage: 0 } : {}) });
      state.menuRetryAt = 0; state.menuFailures = 0;
    } catch (error) {
      state.menuRetryAt = this.now() + Math.min(30000, 1000 * 2 ** (state.menuFailures ?? 0));
      state.menuFailures = (state.menuFailures ?? 0) + 1;
      throw error;
    }
  }
  async publishCard(binding, immediate = false) {
    const state = this.state(binding), now = this.now();
    const current = this.store.binding(binding.chatId, binding.topicId);
    if (!this.sameGeneration(binding, current)) return;
    binding = current;
    if (!binding || binding.frozen || !state.verified) return;
    await this.publishMenuCard(binding);
    binding = this.store.binding(binding.chatId, binding.topicId);
    // Menus own a reply and never change the existing turn/status card.
    if (state.menu?.kind) return;
    await this.retireCard(binding);
    if (this.turnMode(binding)) {
      // Transcript cards require an observed turn; menus publish independently.
      if (!binding.turn && !binding.pendingCard) return;
      if (binding.turn) {
        const previousTurnSignature = turnSignature(binding.turn);
        if (!binding.turn.settled && ['blocked', 'working'].includes(state.status) &&
          (binding.turn.status !== state.status || !binding.turn.activeObserved)) {
          binding.turn.status = state.status; binding.turn.activeObserved = true;
          if (!await this.updateGeneration(binding, { turn: binding.turn })) return;
        }
        if (binding.turn.adapter === 'claude') {
          if (state.transcriptSource?.adapter.transcriptTurns && !binding.turn.settled)
            binding.turn.status = state.status === 'blocked' ? 'blocked' : 'working';
          const duplicates = (binding.outputBatch?.transcript ?? binding.transcript)?.cursor?.duplicates ?? [];
          binding.turn.duplicateWarning = duplicates.length ? `⚠️ 这个会话同时在另一个终端里运行（不在 herdr 中，PID ${duplicates.join('、')}）。两边同时写会把对话记录搞乱，建议只保留一个。` : '';
          if (duplicates.length && (binding.duplicateWarningAt == null || now - binding.duplicateWarningAt >= 3600000)) {
            // Persist the rate limit before sending, including across restarts.
            if (!await this.updateGeneration(binding, { duplicateWarningAt: now })) return;
            await this.feishu.reply(binding.topicId, binding.turn.duplicateWarning);
          }
        }
        const background = binding.transcript?.cursor?.background;
        if (background && !binding.turn.backgroundRetired) {
          binding.turn.background = backgroundView(background, state.visible, now);
          binding.turn.background.finished = binding.turn.background.finished.filter(task => !(binding.turn.backgroundFinishedBefore ?? []).includes(task.id));
        }
        if (binding.turn.adapter === 'claude') binding.turn.liveActivity = binding.turn.settled ? '' : screenActivity(state.visible).spinner;
        if (turnSignature(binding.turn) !== previousTurnSignature && !await this.updateGeneration(binding, { turn: binding.turn })) return;
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
          try { await this.patchCard(cardId, pending.card, binding.cardTurnId ? 'turn' : 'status'); }
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
          cardId = await this.feishu.reply(binding.topicId, renderSchema(pending.card, cardVersion(pending.card)), 'interactive', pending.uuid);
          await this.rememberCard(cardId, pending.card, pending.turnId ? 'turn' : 'status');
        }
        // The old nonce stays valid until publication succeeds. A pending
        // version always has a fresh nonce; consumed versions are never reused.
        await this.store.transaction(data => {
          const b = data.bindings.find(b => b.chatId === binding.chatId && b.topicId === binding.topicId);
          if (this.sameGeneration(binding, b) && b.pendingCard?.nonce === pending.nonce) {
            Object.assign(b, { cardId, nonce: pending.staleNonce ? randomUUID() : pending.nonce, cardCreatedAt: pending.createdAt, pendingCard: null,
              cardTurnId: pending.turnId ?? null, cardSignature: pending.signature, cardNonce: pending.nonce });
            if (pending.turnId) Object.assign(b, { cardAttemptId: cardId, cardAttemptAt: this.now() });
            if (pending.previousCardId && pending.previousCardId !== cardId) {
              b.retiredCardKind = pending.previousCardKind; b.retiredCardId = pending.previousCardId; b.retiredCardAt = pending.previousCardAt; delete b.retiredCardAttempts;
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
      state.cardPending = state.nextSignature !== pending.signature || Boolean(pending.staleNonce);
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
    if (current.turn && current.turn.id !== turn.id) {
      turn.backgroundFinishedBefore ??= [...(current.turn.backgroundFinishedBefore ?? []), ...(current.turn.background?.finished ?? []).map(task => task.id)];
      if (current.turn.background?.running?.length || current.turn.background?.finished?.length || current.turn.backgroundRetired) {
        const old = { ...current.turn, background: undefined, liveActivity: '', backgroundRetired: true, backgroundFinishedBefore: turn.backgroundFinishedBefore };
        if (!await this.updateGeneration(binding, { turn: old })) return false;
        await this.publishCard(this.store.binding(binding.chatId, binding.topicId));
        current = this.store.binding(binding.chatId, binding.topicId);
        if (current.pendingCard || current.cardSignature !== turnSignature(old)) return false;
      }
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
    if (state.transcriptSource?.adapter.transcriptTurns &&
        (state.status === 'working' || this.now() - (current.transcript?.lastRecordAt ?? this.now()) < 30000)) return;
    if ((['idle', 'done'].includes(state.status) && (current.turn.hasOutput || current.turn.activeObserved)) ||
      current.turn.path !== state.transcriptSource?.path) {
      await this.updateGeneration(binding, { turn: { ...current.turn, settled: true, status: 'idle' } });
    }
  }
}
