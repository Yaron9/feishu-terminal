import { randomUUID } from 'node:crypto';
import { CLI_TABLE, sameCwd } from './cli-table.js';
import { screenCard } from './render.js';

const ended = error => ['pane_not_found', 'terminal_finished', 'not_found'].includes(error.code);

// Topic input is serialized by Bridge; session locks also cover different topics.
// Queue entries and launch intent survive restarts. An ambiguous write is never replayed.
export class Wake {
  constructor(bridge, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 90000 } = {}) {
    Object.assign(this, { bridge, sleep, timeoutMs }); this.sessions = new Map();
  }
  async observe(binding, terminal) {
    const b = this.bridge, state = b.state(binding);
    if (b.now() - (state.lastSessionProbe ?? -Infinity) < 1000) return;
    state.lastSessionProbe = b.now();
    const facts = await b.sessionFollow.describe(terminal);
    const current = b.store.binding(binding.chatId, binding.topicId);
    if (!b.sameGeneration(binding, current)) return;
    const changed = facts.cli !== current.cli || facts.cwd !== current.cwd;
    const sessionId = facts.sessionId ?? (changed ? null : current.sessionId) ?? current.claudeSessionId ?? null;
    if (changed || sessionId !== current.sessionId) await b.updateGeneration(binding, { ...facts, sessionId });
  }
  async dormant(binding) {
    const b = this.bridge;
    await b.updateGeneration(binding, { dormant: true, frozen: false, pendingCard: null, pendingMenuCard: null,
      outputBatch: null, recoveryPending: null });
    b.state(binding).verified = false; b.resubscribe();
  }
  async route(binding, action) {
    const b = this.bridge;
    if (binding.wakeTarget && action.type === 'keys') {
      await this.control(binding, action.keys);
      await this.ensure(binding, { wait: false }); return;
    }
    if (action.type === 'ok' && await this.target(binding)) await b.updateGeneration(binding, { needs_check: false });
    if (['input', 'raw', 'keys'].includes(action.type)) {
      await b.store.transaction(data => {
        const current = data.bindings.find(item => item.chatId === binding.chatId && item.topicId === binding.topicId);
        if (!b.sameGeneration(binding, current)) throw Object.assign(new Error('Binding changed'), { code: 'binding_changed' });
        (current.queuedInputs ??= []).push({ id: randomUUID(), ...action });
      });
    }
    await this.ensure(binding);
  }
  async ensure(binding, { wait = true } = {}) {
    const b = this.bridge;
    binding = b.store.binding(binding.chatId, binding.topicId);
    if (!binding || binding.frozen) return;
    const row = CLI_TABLE.find(row => row.cli === binding.cli);
    if (!row || !binding.cwd || !/^[a-zA-Z0-9_-]+$/.test(binding.sessionId ?? '')) {
      if (!binding.unknownSessionNotified) {
        await b.updateGeneration(binding, { unknownSessionNotified: true });
        await b.feishu.reply(binding.topicId, '无法唤醒：没有可靠的会话编号，请从 /t ls 重新打开终端。消息已保留。');
      }
      return;
    }
    const key = binding.sessionId;
    const previous = this.sessions.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.run(binding, row, wait));
    this.sessions.set(key, task);
    try { await task; }
    finally { if (this.sessions.get(key) === task) this.sessions.delete(key); }
  }
  async target(binding) {
    const b = this.bridge, target = binding.wakeTarget;
    if (!target) return null;
    let terminal;
    try { terminal = await b.backend.get(target.paneId); }
    catch (error) { if (ended(error)) return null; throw error; }
    if (b.backend.identity(terminal).terminalId !== target.identity.terminalId) {
      await b.updateGeneration(binding, { frozen: true, dormant: false, wakePending: false });
      b.state(binding).verified = false;
      throw Object.assign(new Error('Wake target replaced'), { code: 'binding_unverified' });
    }
    return terminal;
  }
  async run(snapshot, row, wait) {
    const b = this.bridge;
    let binding = b.store.binding(snapshot.chatId, snapshot.topicId);
    if (!binding || binding.frozen) return;
    if (!binding.dormant && !binding.wakePending) { await this.drain(binding); return; }
    if (!binding.wakePending) {
      await b.updateGeneration(binding, { wakePending: true });
      await b.feishu.reply(binding.topicId, '正在唤醒…');
      binding = b.store.binding(binding.chatId, binding.topicId);
    }
    let terminal = await this.target(binding);
    if (!terminal) {
      // Include unbound terminals and optional Linux SSH processes. A backend
      // list failure aborts this attempt rather than authorizing another run.
      const candidates = await b.sessionFollow.candidates(binding.sessionId);
      const terminals = await b.backend.backends.get('hc')?.list();
      if (!terminals) throw Object.assign(new Error('hc unavailable'), { code: 'backend_unavailable' });
      if (candidates.length) {
        if (candidates.length !== 1) return; // session-follow must reconcile duplicates first
        terminal = b.sessionFollow.terminal(candidates[0], terminals, b.backend);
        if (!terminal) return; // a session running outside hc must not be duplicated
        const owner = b.store.forPane(terminal.pane_id);
        if (owner && owner.topicId !== binding.topicId) return;
      } else {
        for (const live of terminals) {
          const facts = await b.sessionFollow.describe(live);
          if (facts.cli === row.cli && sameCwd(facts.cwd, binding.cwd) && !facts.sessionId) return;
        }
        // A lost run response may still create a process. Keep its intent and
        // discover it by labels on future ticks; never retry that mutation.
        if (binding.wakeAttempt?.phase === 'launching') return;
        await b.updateGeneration(binding, { wakeAttempt: { phase: 'launching', at: b.now() } });
        terminal = await b.backend.backends.get('hc').create(row.resume.replace('{id}', binding.sessionId), binding.cwd,
          { labels: { 'ft.woken': '1', session: binding.sessionId } });
        await b.store.transaction(data => { (data.createdTerminals ??= []).push(terminal.terminal_id); });
      }
      await b.updateGeneration(binding, { wakeTarget: { paneId: terminal.pane_id, identity: b.backend.identity(terminal) },
        wakeAttempt: { phase: 'started', at: b.now() } });
      binding = b.store.binding(binding.chatId, binding.topicId);
    }
    const deadline = b.now() + (wait ? this.timeoutMs : 0);
    for (;;) {
      if (b.stopped) return;
      terminal = await this.target(binding);
      if (!terminal) { await this.dormant(binding); return; }
      if (this.ready(binding, terminal)) {
        await this.rebind(binding, terminal); return;
      }
      if (b.now() >= deadline) break;
      await this.sleep(Math.min(250, deadline - b.now()));
    }
    if (wait || !binding.wakeCardId) await this.screen(binding);
  }
  ready(binding, terminal) {
    return CLI_TABLE.find(row => row.cli === binding.cli)?.readyStates.includes(terminal.status?.state ?? terminal.agent_status);
  }
  async rebind(binding, terminal) {
    const b = this.bridge;
    // Identity is checked again before replacing the durable binding.
    const fresh = await this.target(binding);
    if (!fresh || !this.ready(binding, fresh)) return;
    const moved = await b.store.transaction(data => {
      const current = data.bindings.find(item => item.chatId === binding.chatId && item.topicId === binding.topicId);
      if (!b.sameGeneration(binding, current) || data.bindings.some(item => item !== current && item.paneId === terminal.pane_id)) return null;
      const generation = randomUUID();
      Object.assign(current, { paneId: terminal.pane_id, identity: b.backend.identity(fresh), generation,
        dormant: false, frozen: false, wakePending: false, wakeTarget: null, wakeAttempt: null, wakeCardId: null,
        unknownSessionNotified: false, allowDesktop: true, nonce: randomUUID(), menuNonce: randomUUID(),
        pendingCard: null, pendingMenuCard: null, cardMenu: null, menuConfirm: null, menuPage: 0,
        menuCardId: null, cardSignature: null, menuSignature: null, sessionHandoff: null, outputBatch: null });
      return structuredClone(current);
    });
    if (!moved) return;
    b.runtime.delete(binding.topicId);
    await b.verify(moved); b.resubscribe();
    await this.drain(moved);
  }
  async drain(binding) {
    const b = this.bridge;
    for (;;) {
      binding = b.store.binding(binding.chatId, binding.topicId);
      const item = binding?.queuedInputs?.[0];
      if (!item || binding.dormant || binding.frozen || binding.wakePending || binding.needs_check) return;
      await b.verify(binding);
      // Remove BEFORE entering the existing write path. An uncertain delivery
      // uses needs_check and is never replayed after a crash or a second event.
      await b.updateGeneration(binding, { queuedInputs: binding.queuedInputs.slice(1), needs_check: true });
      if (item.type === 'input') {
        if (await b.input(binding, item.text, true) === false) {
          const current = b.store.binding(binding.chatId, binding.topicId);
          await b.updateGeneration(binding, { queuedInputs: [item, ...(current.queuedInputs ?? [])] });
          return;
        }
      } else await b.writeInput(binding, item.type === 'raw' ? 'text' : 'keys', item.type === 'raw' ? { text: item.text } : { keys: item.keys }, false, true);
    }
  }
  async screen(binding) {
    const b = this.bridge, terminal = await this.target(binding);
    if (!terminal) return;
    const { read } = await b.backend.read(terminal.pane_id, { source: 'visible' });
    if (!await this.target(binding)) return;
    const nonce = randomUUID();
    const card = screenCard({ paneId: terminal.pane_id, topicId: binding.topicId, nonce, text: read.text,
      label: binding.cli, agent: binding.cli, status: 'blocked', suppressMenu: true,
      note: '唤醒仍在等待确认，消息已排队。请使用按键处理屏幕后刷新。' });
    const cardId = await b.feishu.reply(binding.topicId, card, 'interactive');
    await b.rememberCard(cardId, card, 'status');
    await b.updateGeneration(binding, { cardId, nonce, cardCreatedAt: b.now(), wakeCardId: cardId,
      menuCardId: null, cardMenu: null });
  }
  async button(binding, event) {
    const b = this.bridge;
    if (binding.wakeCardId === event.messageId && event.key !== 'refresh') {
      const terminal = await this.target(binding);
      if (!terminal || binding.needs_check) return;
      if (!this.ready(binding, terminal)) await this.control(binding, [event.key]);
    }
    await this.ensure(binding, { wait: !binding.wakeTarget });
    const current = b.store.binding(binding.chatId, binding.topicId);
    if (current?.wakePending) await this.screen(current);
  }
  async control(binding, keys) {
    const b = this.bridge, terminal = await this.target(binding);
    if (!terminal || binding.needs_check) return;
    await b.updateGeneration(binding, { needs_check: true });
    await b.backend.sendKeys(terminal.pane_id, keys);
    await b.updateGeneration(binding, { needs_check: false });
  }
  async tick(binding) {
    const b = this.bridge;
    if (!binding) return;
    if (binding.wakePending || (binding.dormant && binding.queuedInputs?.length)) await this.ensure(binding, { wait: false });
    else if (!binding.dormant && binding.queuedInputs?.length) await this.drain(binding);
  }
}
