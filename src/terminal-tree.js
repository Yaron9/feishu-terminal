import { randomUUID } from 'node:crypto';
import { cleanTitle, topicTitle, topicCard } from './topics.js';
import { clean } from './render.js';

const literal = value => clean(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_\[\]~!]/g, '\\$&');
const markdown = content => ({ tag: 'markdown', content });
const card = (title, elements, template = 'blue') => ({ schema: '2.0', config: { update_multi: true },
  header: { template, title: { tag: 'plain_text', content: title } }, body: { elements } });
const button = (label, topicId, nonce, key) => ({ tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default',
  behaviors: [{ type: 'callback', value: { topic_id: topicId, nonce, key } }] });
const gone = error => ['not_found', 'pane_not_found', 'terminal_finished'].includes(error.code);
const statusLabel = { working: '工作中', ready: '已空闲', blocked: '待审批', finished: '已结束', unknown: '状态未知' };

// Tree cards have their own durable publications. They never rotate an input
// card's nonce, and navigation never sends terminal input or wakes a session.
export class TerminalTree {
  constructor(bridge) { this.bridge = bridge; }
  parentId(pane) {
    if (!pane.pane_id.startsWith('hc:') || typeof pane.parent !== 'string' || !pane.parent) return null;
    if (pane.parent.startsWith('hc:')) return pane.parent;
    const address = pane.pane_id.slice(3), namespace = address.includes('/') ? address.slice(0, address.lastIndexOf('/') + 1) : '';
    return `hc:${pane.parent.includes('/') ? pane.parent : namespace + pane.parent}`;
  }
  relation(pane, chatId) {
    const b = this.bridge, parent = b.store.forPane(this.parentId(pane));
    if (!parent?.identity?.terminalId || parent.paneId === pane.pane_id || parent.chatId !== chatId || !b.registry.get(chatId)) return null;
    return { parentTopicId: parent.topicId, parentTerminalId: parent.identity.terminalId,
      parentTitle: b.sessionIdentity(parent).title, name: cleanTitle(pane.name), createdAt: pane.created_ms ?? b.now(),
      navNonce: randomUUID(), status: 'unknown', notices: [] };
  }
  parent(binding) {
    const b = this.bridge, relation = binding.tree;
    if (!relation) return null;
    return b.store.list().find(parent => parent.chatId === binding.chatId &&
      (parent.topicId === relation.parentTopicId || parent.identity?.terminalId === relation.parentTerminalId)) ?? null;
  }
  view(binding, pane) {
    if (!binding.tree) return null;
    const b = this.bridge, parent = this.parent(binding);
    const ownTitle = pane ? topicTitle(pane, binding.sessionTitle) : b.sessionIdentity(binding).title;
    return { name: cleanTitle(pane?.name) || binding.tree.name || ownTitle,
      parentTitle: parent ? b.sessionIdentity(parent).title : binding.tree.parentTitle,
      parentTopicId: parent?.topicId ?? binding.tree.parentTopicId, url: parent?.topicNavigation?.url ?? null,
      nonce: binding.tree.navNonce };
  }
  title(pane, ownTitle, binding) {
    const view = this.view({ ...binding, sessionTitle: ownTitle }, pane);
    return view ? `└ ${view.name} · ${view.parentTitle}` : ownTitle;
  }
  decorate(value, binding, pane) {
    const view = this.view(binding, pane);
    if (!view) return value;
    const elements = [markdown(`└ ${literal(view.name)} · 父：${literal(view.parentTitle)}` +
      (view.url ? ` [返回](${view.url})` : ''))];
    if (!view.url) elements.push(button('返回', binding.topicId, view.nonce, 'tree:parent'));
    if (value.body) return { ...value, body: { ...value.body, elements: [value.body.elements[0], ...elements, ...value.body.elements.slice(1)] } };
    // Legacy status cards use JSON 1.0; renderSchema converts this callback.
    return { ...value, elements: [value.elements[0], ...elements.map(e => e.tag === 'button' ?
      { tag: 'action', actions: [{ ...e, value: e.behaviors[0].value, behaviors: undefined }] } : e), ...value.elements.slice(1)] };
  }
  root(pane, ownTitle, sessionId, known) {
    return this.decorate(topicCard(pane, this.title(pane, ownTitle, known), undefined, sessionId, ownTitle),
      { ...known, sessionTitle: ownTitle }, pane);
  }
  async ensureLink(binding) {
    const b = this.bridge;
    if (binding.topicNavigation?.url || b.now() - (binding.topicNavigation?.attemptAt ?? -Infinity) < 60000) return;
    let url = null;
    try {
      const message = await b.feishu.getMessage(binding.topicId);
      if ((message.message_id && message.message_id !== binding.topicId) || (message.chat_id && message.chat_id !== binding.chatId))
        throw new Error('Navigation metadata does not match topic');
      if (message.thread_id) {
        const query = new URLSearchParams({ openchatid: binding.chatId, openthreadid: message.thread_id,
          open_chat_id: binding.chatId, open_thread_id: message.thread_id,
          thread_position: String(message.thread_message_position ?? 0) });
        url = `https://applink.feishu.cn/client/thread/open?${query}`;
      } else if (Number.isSafeInteger(Number(message.message_position)) && message.message_position != null) {
        url = `https://applink.feishu.cn/client/chat/open?${new URLSearchParams({ openChatId: binding.chatId, position: String(message.message_position) })}`;
      }
    } catch { /* Hosts without navigation metadata retain the topic-bump action. */ }
    await b.updateGeneration(binding, { topicNavigation: { url, attemptAt: b.now() } });
  }
  async observe(binding, pane) {
    const b = this.bridge, current = b.store.binding(binding.chatId, binding.topicId);
    if (!current?.tree || !b.sameGeneration(binding, current)) return;
    if (current.tree.notices.some(notice => notice.terminalId === current.identity.terminalId)) return;
    const status = ({ idle: 'ready', done: 'ready' })[b.backend.status(pane, b.state(current).visible)] ?? b.backend.status(pane, b.state(current).visible);
    const parent = this.parent(current), tree = { ...current.tree, name: cleanTitle(pane.name), status, finishedAt: null,
      parentTopicId: parent?.topicId ?? current.tree.parentTopicId,
      parentTitle: parent ? b.sessionIdentity(parent).title : current.tree.parentTitle };
    if (JSON.stringify(tree) !== JSON.stringify(current.tree)) {
      const changed = await b.store.transaction(data => {
        const saved = data.bindings.find(item => item.chatId === current.chatId && item.topicId === current.topicId);
        if (!b.sameGeneration(current, saved) || saved.tree.notices.some(notice => notice.terminalId === saved.identity.terminalId)) return false;
        saved.tree = { ...tree, notices: saved.tree.notices }; return true;
      });
      if (changed) b.state(current).cardPending = b.state(current).forceTurnCard = true;
    }
  }
  async finished(binding) {
    const b = this.bridge, current = b.store.binding(binding.chatId, binding.topicId);
    if (!current?.tree || !b.sameGeneration(binding, current)) return;
    if (current.tree.status === 'finished' && current.tree.notices.some(notice => notice.terminalId === current.identity.terminalId)) return;
    const notice = { terminalId: current.identity.terminalId, uuid: randomUUID(), createdAt: b.now(), topicId: current.topicId,
      card: b.sessionCard(card(`已结束 · ${current.tree.name || b.sessionIdentity(current).title}`,
        [markdown('子终端已结束。')], 'grey'), current) };
    await b.store.transaction(data => {
      const saved = data.bindings.find(item => item.chatId === current.chatId && item.topicId === current.topicId);
      if (!b.sameGeneration(current, saved)) return;
      saved.tree.status = 'finished'; saved.tree.finishedAt ??= b.now();
      if (!saved.tree.notices.some(item => item.terminalId === current.identity.terminalId)) {
        saved.tree.notices = saved.tree.notices.filter(item => !item.messageId).concat(saved.tree.notices.filter(item => item.messageId).slice(-10), notice);
      }
    });
  }
  async closing(binding) {
    const b = this.bridge;
    for (const notice of binding.tree?.notices ?? []) {
      if (notice.messageId || b.now() - notice.createdAt >= 55 * 60000 || b.now() < (notice.retryAt ?? 0)) continue;
      try {
        const id = await b.feishu.reply(notice.topicId, notice.card, 'interactive', notice.uuid);
        await b.rememberCard(id, notice.card, 'tree');
        await b.store.transaction(data => {
          const current = data.bindings.find(item => item.chatId === binding.chatId && item.topicId === binding.topicId);
          const saved = current?.tree?.notices.find(item => item.uuid === notice.uuid);
          if (saved) saved.messageId = id;
        });
      } catch (error) {
        await b.store.transaction(data => {
          const saved = data.bindings.find(item => item.topicId === binding.topicId)?.tree?.notices.find(item => item.uuid === notice.uuid);
          if (saved) saved.retryAt = b.now() + 2000;
        });
        b.reportFailure('child_closing_failed', error);
      }
    }
  }
  async create(pane, parent) {
    const b = this.bridge;
    return b.enqueue(() => b.enqueue(async () => {
      if (b.store.forPane(pane.pane_id) || b.store.data.treeSeen?.includes(pane.terminal_id)) return;
      const owner = b.store.binding(parent.chatId, parent.topicId);
      if (!owner || owner.frozen || owner.dormant || !b.registry.get(owner.chatId)) return;
      await b.verify(owner);
      const fresh = await b.backend.get(pane.pane_id);
      if (!b.identitiesMatch({ paneId: pane.pane_id, identity: b.backend.identity(pane) }, fresh) || this.parentId(fresh) !== owner.paneId) return;
      let intent = b.store.data.childTopics?.find(item => item.terminalId === pane.terminal_id);
      if (intent && (intent.chatId !== owner.chatId || b.now() - intent.createdAt >= 55 * 60000)) return;
      if (!intent) {
        const tree = this.relation(fresh, owner.chatId);
        const root = await b.newRoot(fresh, undefined, { tree, chatId: owner.chatId });
        intent = { terminalId: pane.terminal_id, paneId: pane.pane_id, chatId: owner.chatId, parentTopicId: owner.topicId,
          uuid: randomUUID(), createdAt: b.now(), tree, root };
        await b.store.transaction(data => { (data.childTopics ??= []).push(intent); });
      }
      await b.openSerial({ kind: 'tree', chatId: owner.chatId }, pane.pane_id, pane.terminal_id, { automatic: true, intent });
      if (b.store.forPane(pane.pane_id)?.identity.terminalId === pane.terminal_id)
        await b.store.transaction(data => { data.childTopics = (data.childTopics ?? []).filter(item => item.terminalId !== pane.terminal_id); });
    }, `open:${pane.pane_id}`), parent.topicId);
  }
  rows(parent) {
    const b = this.bridge;
    return b.store.list().filter(child => child.chatId === parent.chatId && child.tree && this.parent(child)?.topicId === parent.topicId).map(child => ({
      topicId: child.topicId, name: child.tree.name || b.sessionIdentity(child).title, title: b.sessionIdentity(child).title,
      sessionId: b.sessionIdentity(child).sessionId, status: child.tree.status,
      age: b.now() - child.tree.createdAt < 60000 ? '刚刚' : `${Math.floor((b.now() - child.tree.createdAt) / 60000)} 分钟`,
      url: child.topicNavigation?.url ?? null,
    }));
  }
  render(parent, rows, nonce) {
    const elements = rows.flatMap((row, index) => {
      const status = row.status === 'blocked' ? "<font color='orange'>**待审批**</font>" : statusLabel[row.status] ?? '状态未知';
      const line = `● ${literal(row.name)} · ${literal(row.title)} · ${literal(row.sessionId?.slice(0, 8) ?? '编号未知')}  ${status} ${row.age}`;
      return [markdown(line + (row.url ? ` [打开](${row.url})` : '')),
        ...(!row.url ? [button('打开', parent.topicId, nonce, `tree:open:${index}`)] : [])];
    });
    return card(`子终端 (${rows.length})`, elements.length ? elements : [markdown('暂无子终端。')], rows.some(row => row.status === 'blocked') ? 'orange' : 'blue');
  }
  async publish(parent) {
    const b = this.bridge, current = b.store.binding(parent.chatId, parent.topicId);
    if (!current || !b.registry.get(current.chatId)) return;
    const rows = this.rows(current), signature = JSON.stringify(rows), state = b.state(current);
    let saved = current.childrenCard ?? {};
    if (!rows.length && !saved.cardId && !saved.pending) return;
    if (state.childrenCandidate !== signature) { state.childrenCandidate = signature; state.childrenSince = b.now(); }
    if (!saved.pending && (signature === saved.signature || (saved.cardId && b.now() - state.childrenSince < 1000))) return;
    if (b.now() < (saved.retryAt ?? 0)) return;
    let pending = saved.pending;
    if (!pending) {
      const nonce = randomUUID();
      pending = { uuid: randomUUID(), nonce, rows, signature, card: this.render(current, rows, nonce), createdAt: b.now(), targetId: saved.cardId ?? null };
      saved = { ...saved, pending };
      if (!await b.updateGeneration(current, { childrenCard: saved })) return;
    }
    if (!pending.targetId && b.now() - pending.createdAt >= 55 * 60000) return;
    try {
      let id = pending.targetId;
      if (id) {
        try { await b.patchCard(id, pending.card, 'tree'); }
        catch (error) {
          if (!['230011', '230031', '230110'].includes(String(error.code))) throw error;
          pending.targetId = null; id = null;
          saved = { ...saved, pending };
          if (!await b.updateGeneration(current, { childrenCard: saved })) return;
        }
      }
      if (!id) {
        id = await b.feishu.reply(current.topicId, pending.card, 'interactive', pending.uuid);
        await b.rememberCard(id, pending.card, 'tree');
      }
      await b.updateGeneration(current, { childrenCard: { cardId: id, signature: pending.signature, nonce: pending.nonce, rows: pending.rows } });
    } catch (error) {
      await b.updateGeneration(current, { childrenCard: { ...saved, retryAt: b.now() + 2000 } });
      b.reportFailure('children_card_failed', error);
    }
  }
  async navigate(event, binding) {
    const b = this.bridge;
    const source = binding ?? b.store.list().find(item => item.chatId === event.chatId && item.topicId === event.messageId);
    let target;
    if (source && event.key === 'tree:parent' && source.tree?.navNonce === event.nonce &&
        [source.topicId, source.cardId, source.menuCardId, ...(source.tree.notices ?? []).map(notice => notice.messageId)].includes(event.messageId)) target = this.parent(source);
    if (source && /^tree:open:\d+$/.test(event.key) && source.childrenCard?.cardId === event.messageId && source.childrenCard.nonce === event.nonce) {
      const row = source.childrenCard.rows[Number(event.key.split(':')[2])];
      target = row && b.store.binding(event.chatId, row.topicId);
      if (target && this.parent(target)?.topicId !== source.topicId) target = null;
    }
    if (!target || target.chatId !== event.chatId || !b.registry.get(target.chatId)) {
      await b.feishu.reply(event.topicId || event.messageId, '这张卡片已失效，请查看当前话题。'); return;
    }
    await b.feishu.reply(target.topicId, `📍 已打开话题「${b.sessionIdentity(target).title}」`);
    await b.feishu.reply(source.topicId, '已在列表最上面打开话题。');
  }
  async tick() {
    const b = this.bridge, hc = b.backend.backends?.get('hc');
    if (!hc || !b.store.list().some(item => item.paneId.startsWith('hc:') && b.registry.get(item.chatId))) return;
    if (b.now() - (this.lastScan ?? -Infinity) < 1000) return;
    this.lastScan = b.now();
    let panes;
    try { panes = await hc.list(); }
    catch (error) { b.backend.reportError(hc, error); return; }
    // Capture current session names/IDs before computing tree-card candidates;
    // ordinary output refresh happens later in the bridge tick.
    for (const binding of b.store.list().filter(item => b.registry.get(item.chatId) && !item.frozen && !item.dormant &&
      (item.tree || panes.some(pane => this.parentId(pane) === item.paneId)))) {
      const pane = panes.find(item => b.identitiesMatch(binding, item));
      if (pane) await b.wake.observe(binding, pane);
    }
    let progress;
    do {
      progress = false;
      for (const pane of panes) {
        const parent = b.store.forPane(this.parentId(pane));
        if (!parent || !b.registry.get(parent.chatId) || parent.frozen || parent.dormant) continue;
        const existing = b.store.forPane(pane.pane_id);
        if (existing) {
          if (!existing.tree && existing.chatId === parent.chatId && b.identitiesMatch(existing, pane) && existing.paneId !== parent.paneId)
            if (await b.updateGeneration(existing, { tree: this.relation(pane, parent.chatId) }))
              await b.store.transaction(data => { data.treeSeen = [...new Set([...(data.treeSeen ?? []), pane.terminal_id])]; });
          continue;
        }
        try { await this.ensureLink(parent); await this.create(pane, parent); progress ||= Boolean(b.store.forPane(pane.pane_id)); }
        catch (error) { b.reportFailure('child_topic_failed', error); }
      }
    } while (progress);
    const linked = b.store.list().filter(item => item.tree && b.registry.get(item.chatId));
    for (const child of linked) {
      try {
        const terminal = hc.inspect ? await hc.inspect(child.paneId) : await hc.get(child.paneId);
        if (!b.identitiesMatch(child, terminal)) continue;
        if (terminal.state === 'finished') { await this.finished(child); if (!child.dormant) await b.wake.dormant(child); }
        else await this.observe(child, terminal);
      } catch (error) {
        if (gone(error) && !panes.some(p => p.pane_id === child.paneId)) {
          await this.finished(child); if (!child.dormant) await b.wake.dormant(child);
        } else b.reportFailure('child_observation_failed', error);
      }
      const current = b.store.binding(child.chatId, child.topicId);
      await this.ensureLink(current);
      const parent = this.parent(current); if (parent) await this.ensureLink(parent);
      await this.closing(current);
    }
    for (const parent of b.store.list().filter(item => b.registry.get(item.chatId)))
      await b.enqueue(() => this.publish(parent), `tree-card:${parent.topicId}`);
  }
}
