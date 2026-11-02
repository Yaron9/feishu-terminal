import { randomUUID } from 'node:crypto';
import { pickerCard, splitText } from './render.js';

const CHANGED = '终端已变化，请重新 /t ls';
const EXPIRED = '卡片已过期，请重新 /t ls';

// Management cards share the bridge ACL/callback path and the atomic Store.
// One nonce covers all buttons on a card; an action invalidates every sibling.
export class PanePicker {
  constructor(bridge) { this.bridge = bridge; }
  entry(pane) {
    const b = this.bridge.store.forPane(pane.pane_id);
    return { paneId: pane.pane_id, label: this.bridge.label(pane),
      identity: (!b?.frozen && b?.identity) || { terminalId: pane.terminal_id, workspaceId: pane.workspace_id, tabId: pane.tab_id },
      bindingTopic: b?.topicId ?? null, generation: b?.generation ?? null };
  }
  async show(event, binding) {
    const b = this.bridge;
    const { panes } = await b.herdr.request('pane.list');
    const selected = binding ? panes.filter(p => p.pane_id === binding.paneId) : panes;
    if (binding && !selected.length) { await b.feishu.reply(event.topicId, CHANGED); return; }
    const card = { kind: binding ? 'close' : 'list', chatId: event.chatId, topicId: event.topicId,
      entries: selected.map(p => this.entry(p)), createdAt: b.now(), nonce: randomUUID() };
    try {
      card.messageId = await b.feishu.reply(event.topicId, pickerCard(card), 'interactive');
      await b.store.saveActionCard(card, b.now());
    } catch (error) {
      if (binding) throw error;
      for (const part of splitText(card.entries.map(e => e.label).join('\n') || '暂无终端')) await b.feishu.reply(event.topicId, part);
    }
  }
  async replace(card, kind, entry) {
    const b = this.bridge;
    const next = { ...card, kind, entries: [entry], nonce: randomUUID() };
    await b.feishu.patch(card.messageId, pickerCard(next));
    await b.store.saveActionCard(next, b.now());
  }
  async verify(entry) {
    const b = this.bridge;
    const { panes } = await b.herdr.request('pane.list');
    const pane = panes.find(p => p.pane_id === entry.paneId);
    if (!pane || !entry.identity?.terminalId || pane.terminal_id !== entry.identity.terminalId) throw new Error(CHANGED);
    let identity;
    try { identity = await b.identity(entry.paneId, true); }
    catch { throw new Error(CHANGED); }
    if (Object.keys(identity).some(k => identity[k] !== entry.identity[k])) throw new Error(CHANGED);
    return pane;
  }
  async button(event) {
    const b = this.bridge, card = b.store.actionCard(event.messageId);
    const stale = async () => b.feishu.reply(event.topicId || event.messageId, '卡片已失效或过期，请重新 /t ls');
    if (!card || card.chatId !== event.chatId || card.topicId !== event.topicId || card.nonce !== event.nonce) { await stale(); return; }
    const match = /^picker:(open|close|unbind|kill|cancel):(\d+)$/.exec(event.key);
    const allowed = card.kind === 'list' ? ['open', 'close'] : card.kind === 'confirm' ? ['kill', 'cancel'] : ['unbind', 'kill', 'cancel'];
    const entry = match && card.entries[Number(match[2])];
    if (!entry || !allowed.includes(match[1])) { await stale(); return; }
    if (!await b.store.consumeActionCard(card)) { await stale(); return; }
    const finish = result => b.feishu.patch(card.messageId, pickerCard(card, result));
    if (!Number.isFinite(card.createdAt) || b.now() - card.createdAt >= 600000 || b.now() < card.createdAt) { await finish(EXPIRED); return; }
    let pane;
    try { pane = await this.verify(entry); }
    catch { await finish(CHANGED); return; }
    const action = match[1];
    await b.log(event, { topicId: entry.bindingTopic ?? card.topicId, paneId: entry.paneId }, `picker_${action}`);
    if (action === 'cancel') { await finish('已取消'); return; }
    const binding = b.store.forPane(entry.paneId);
    if ((binding?.topicId ?? null) !== entry.bindingTopic || (binding?.generation ?? null) !== entry.generation ||
      (binding && binding.chatId !== event.chatId)) { await finish(CHANGED); return; }
    try {
      if (action === 'open' && binding) {
        await b.open(event, entry.paneId, entry.identity.terminalId);
        await finish({ index: Number(match[2]), text: `已在话题「${b.label(pane)}」，已置顶` }); return;
      }
      if (action === 'open') {
        const topicId = await b.open(event, entry.paneId, entry.identity.terminalId);
        const opened = b.store.binding(event.chatId, topicId);
        if (opened) await b.refresh(opened, true);
        await finish(`已打开话题 ${topicId}`); return;
      }
      if (action === 'close') { await this.replace(card, 'close', entry); return; }
      if (action === 'kill') {
        // Refresh status too: an idle agent may have started working while
        // the audit record was being persisted.
        pane = await this.verify(entry);
        const owned = b.store.data.createdTerminals?.includes(pane.terminal_id);
        if (card.kind !== 'confirm' && (!owned || (pane.agent && ['working', 'blocked'].includes(pane.agent_status)))) {
          await this.replace(card, 'confirm', { ...entry, label: b.label(pane) }); return;
        }
        const latest = b.store.forPane(entry.paneId);
        if ((latest?.generation ?? null) !== entry.generation || (latest?.topicId ?? null) !== entry.bindingTopic) {
          await finish(CHANGED); return;
        }
        await b.herdr.request('pane.close', { pane_id: entry.paneId });
      }
      if (binding) {
        const removed = await b.store.transaction(data => {
          const index = data.bindings.findIndex(current => current.chatId === binding.chatId && current.topicId === binding.topicId &&
            current.generation === binding.generation);
          if (index < 0) return false;
          data.bindings.splice(index, 1); return true;
        });
        if (removed) { b.runtime.delete(binding.topicId); b.resubscribe(); }
      }
      await finish(action === 'kill' ? '已关闭' : '已解绑');
    } catch (error) {
      await finish(error.message === CHANGED ? CHANGED : '操作未完成，请重新 /t ls 检查；不会自动重试');
    }
  }
}
