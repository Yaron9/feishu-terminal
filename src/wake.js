import { randomUUID } from 'node:crypto';
import { CLI_TABLE, lookupCli, sameCwd } from './cli-table.js';
import { screenCard } from './render.js';
import { topicTitle } from './topics.js';

const ended = error => ['pane_not_found', 'terminal_finished', 'not_found'].includes(error.code);

// Topic input is serialized by Bridge; session locks also cover different topics.
// Queue entries and launch intent survive restarts. An ambiguous write is never replayed.
export class Wake {
  constructor(bridge, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 90000 } = {}) {
    Object.assign(this, { bridge, sleep, timeoutMs }); this.sessions = new Map();
  }
  async observe(binding, terminal) {
    const b = this.bridge, state = b.state(binding);
    const sessionTitle = topicTitle(terminal, b.sessionIdentity(binding).title);
    if (sessionTitle && sessionTitle !== b.store.binding(binding.chatId, binding.topicId)?.sessionTitle) {
      if (await b.updateGeneration(binding, { sessionTitle })) state.cardPending = state.forceTurnCard = true;
    }
    await b.tree.observe(binding, terminal);
    if (b.now() - (state.lastSessionProbe ?? -Infinity) < 1000) return;
    state.lastSessionProbe = b.now();
    const facts = await b.sessionFollow.describe(terminal);
    let soleTerminal = false;
    if (facts.sessionId && !facts.sessionVerified) {
      const terminals = await b.backend.backends.get(terminal.pane_id.startsWith('hc:') ? 'hc' : 'herdr').list();
      const matching = terminals.filter(term => lookupCli(term)?.cli === facts.cli &&
        sameCwd(term.foreground?.cwd ?? term.foreground_cwd ?? term.cwd, facts.cwd));
      soleTerminal = matching.length === 1 && matching[0].pane_id === terminal.pane_id;
    }
    const current = b.store.binding(binding.chatId, binding.topicId);
    if (!b.sameGeneration(binding, current)) return;
    // Concurrent same-CLI panes in one cwd make the cwd probe ambiguous, and
    // soleTerminal stays false even when only one session exists. Attribute a
    // candidate by the exact text ft sent into this binding's own pane: only
    // that binding can match it, so concurrent topics each claim their own
    // session instead of blocking each other. Identical texts stay unclaimed.
    const ownInputs = (current.sentInputs ?? []).filter(input => current.identity?.terminalId && input.terminalId === current.identity.terminalId);
    let sentMatch = null;
    if (!facts.sessionVerified && !soleTerminal && !current.sessionId && !current.dormant && !current.wakePending && !current.wakeAttempt && ownInputs.length) {
      const cache = state.sentTextCandidates ??= new Map();
      for (const candidate of facts.probeCandidates ?? []) {
        if (!candidate.source) continue;
        if (!cache.has(candidate.source)) cache.set(candidate.source, b.sessionFollow.sentTextMatch(candidate, ownInputs));
        if (await cache.get(candidate.source)) { sentMatch = candidate.sessionId; break; }
      }
    }
    await b.store.transaction(data => {
      const item = data.bindings.find(x => x.chatId === binding.chatId && x.topicId === binding.topicId);
      if (!b.sameGeneration(binding, item)) return;
      if (data.reaps?.some(record => record.paneId === item.paneId)) return;
      // A wake in flight (fresh launch after /engine, dormant rebind) is the
      // binding's own intent about cli, cwd and session. Every fact here comes
      // from the old pane still tearing down; assigning any of them mid-switch
      // would undo the switch. Session attribution resumes on the next probe.
      if (item.wakeAttempt || item.wakePending || item.dormant) return;
      const changed = facts.cli !== item.cli || facts.cwd !== item.cwd;
      let id = changed ? null : item.sessionId, source = changed ? null : item.sessionSource;
      if (facts.cli === 'claude') {
        id = (facts.sessionVerified ? facts.sessionId : null) ?? (changed ? null : item.sessionId) ?? item.claudeSessionId ?? null;
        source = facts.sessionVerified ? 'verified' : source;
      } else if (facts.sessionVerified) { id = facts.sessionId; source = 'verified'; }
      else {
        const claim = facts.sessionId ?? sentMatch;
        if (claim && (sentMatch === claim || soleTerminal || (Number.isFinite(facts.sessionStartedAt) &&
          (item.sentInputs ?? []).some(input => input.terminalId === item.identity?.terminalId && input.sentAt <= facts.sessionStartedAt &&
            /^(codex|pi)(?:\s|$)/i.test(input.prefix ?? '')))) &&
          !data.bindings.some(other => other !== item && other.sessionId === claim)) {
          id = claim; source = 'probe';
        }
      }
      if (changed || id !== item.sessionId || source !== item.sessionSource) {
        Object.assign(item, { cli: facts.cli, cwd: facts.cwd, sessionId: id, sessionSource: source, sessionVerified: source === 'verified' });
        state.cardPending = state.forceTurnCard = true;
      }
    });
  }
  async dormant(binding) {
    const b = this.bridge;
    await b.updateGeneration(binding, { dormant: true, frozen: false, pendingCard: null, pendingMenuCard: null,
      outputBatch: null, recoveryPending: null });
    await b.tree.finished(binding);
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
    const replay = ['codex', 'pi'].includes(binding.cli) && !binding.sessionId && binding.sessionReplay;
    // freshLaunch: the group default CLI is launched by run(); no session id exists yet.
    if (!row || !binding.cwd || (!replay && !binding.freshLaunch && !/^[a-zA-Z0-9_-]+$/.test(binding.sessionId ?? ''))) {
      if (!binding.unknownSessionNotified) {
        await b.updateGeneration(binding, { unknownSessionNotified: true });
        await b.feishu.reply(binding.topicId, '无法唤醒：没有可靠的会话编号，请从 /t ls 重新打开终端。消息已保留。');
      }
      return;
    }
    const key = binding.sessionId ?? `topic:${binding.topicId}`;
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
      if (!(binding.freshLaunch && binding.topicRoot?.type === 'user'))
        await b.feishu.reply(binding.topicId, '正在唤醒…');
      binding = b.store.binding(binding.chatId, binding.topicId);
    }
    let terminal = await this.target(binding);
    if (!terminal) {
      // Include unbound terminals and optional Linux SSH processes. A backend
      // list failure aborts this attempt rather than authorizing another run.
      const candidates = binding.sessionId ? await b.sessionFollow.candidates(binding.sessionId) : [];
      const terminals = await b.backend.backends.get('hc')?.list();
      if (!terminals) throw Object.assign(new Error('hc unavailable'), { code: 'backend_unavailable' });
      if (candidates.length) {
        if (candidates.length !== 1) return; // session-follow must reconcile duplicates first
        terminal = b.sessionFollow.terminal(candidates[0], terminals, b.backend);
        if (!terminal) return; // a session running outside hc must not be duplicated
        const owner = b.store.forPane(terminal.pane_id);
        if (owner && owner.topicId !== binding.topicId) return;
      } else {
        // A freshLaunch starts a brand-new session and cannot duplicate one.
        // A live pane owned by another binding is already known to ft; only an
        // unowned unverified same-CLI pane may be that session running outside ft.
        if (!binding.freshLaunch) {
          for (const live of terminals) {
            const owner = b.store.forPane(live.pane_id);
            if (owner && owner.topicId !== binding.topicId) continue;
            const facts = await b.sessionFollow.describe(live);
            if (facts.cli === row.cli && sameCwd(facts.cwd, binding.cwd) && !facts.sessionVerified) return;
          }
        }
        // A lost run response may still create a process. Keep its intent and
        // discover it by labels on future ticks; never retry that mutation.
        if (binding.wakeAttempt?.phase === 'launching') return;
        // Restore native ancestry only when the saved parent is already live.
        // Waking either topic never recursively launches the other sessions.
        const parent = b.tree.parent(binding);
        let parentId;
        if (parent && !parent.dormant && !parent.frozen && /^hc:t[a-zA-Z0-9]+$/.test(parent.paneId)) {
          try {
            const live = await b.backend.get(parent.paneId);
            if (b.identitiesMatch(parent, live)) parentId = parent.paneId;
          } catch (error) { if (!ended(error)) throw error; }
        }
        await b.updateGeneration(binding, { wakeAttempt: { phase: 'launching', at: b.now() } });
        terminal = await b.backend.backends.get('hc').create(binding.sessionId ? row.resume.replace('{id}', binding.sessionId) : (binding.cliCommand && !/\b(?:resume|--session)\b/i.test(binding.cliCommand) ? binding.cliCommand : row.cli), binding.cwd,
          { labels: { 'ft.woken': '1', ...(binding.sessionId ? { session: binding.sessionId } : {}) }, ...(parentId ? { parent: parentId } : {}) });
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
        dormant: false, frozen: false, freshLaunch: null, wakePending: false, wakeTarget: null, wakeAttempt: null, wakeCardId: null,
        firstWakeCardId: current.freshLaunch && current.topicRoot?.type === 'user' ? current.wakeCardId : null,
        unknownSessionNotified: false, allowDesktop: true, nonce: randomUUID(), menuNonce: randomUUID(),
        pendingCard: null, pendingMenuCard: null, cardMenu: null, menuConfirm: null, menuPage: 0,
        menuCardId: null, cardSignature: null, menuSignature: null, sessionHandoff: null, outputBatch: null });
      if (current.tree) data.treeSeen = [...new Set([...(data.treeSeen ?? []), current.identity.terminalId])];
      for (const child of data.bindings) if (child.chatId === current.chatId && child.tree?.parentTopicId === current.topicId)
        child.tree.parentTerminalId = current.identity.terminalId;
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
    const card = b.sessionCard(screenCard({ paneId: terminal.pane_id, topicId: binding.topicId, nonce, text: read.text,
      label: binding.cli, agent: binding.cli, status: 'blocked', suppressMenu: true,
      note: '唤醒仍在等待确认，消息已排队。请使用按键处理屏幕后刷新。' }), binding);
    const cardId = binding.wakeCardId ?? await b.feishu.reply(binding.topicId, card, 'interactive');
    if (binding.wakeCardId) await b.patchCard(cardId, card, 'status');
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
    b.reap.input(binding.topicId);
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
