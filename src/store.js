import { mkdir, open, readFile, rename, appendFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class Store {
  constructor(file, { dedupeLimit = 10000 } = {}) {
    this.file = file; this.dedupeLimit = dedupeLimit;
    this.data = { version: 1, bindings: [], seen: [] }; this.queue = Promise.resolve();
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.bindings) || !Array.isArray(data.seen)) throw new Error('Invalid bridge state');
      const topics = new Set(), panes = new Set();
      for (const b of data.bindings) {
        if (!b.chatId || !b.topicId || !b.paneId || topics.has(b.topicId) || panes.has(b.paneId)) throw new Error('Invalid bindings');
        topics.add(b.topicId); panes.add(b.paneId);
      }
      this.data = data;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  list() { return structuredClone(this.data.bindings); }
  binding(chatId, topicId) { return this.list().find(b => b.chatId === chatId && b.topicId === topicId); }
  forPane(paneId) { return this.list().find(b => b.paneId === paneId); }
  transaction(change) {
    const result = this.queue.then(async () => {
      const next = structuredClone(this.data);
      const value = change(next);
      await this.write(next); this.data = next; return value;
    });
    this.queue = result.catch(() => {}); return result;
  }
  async write(data) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(data)); await handle.sync(); await handle.close(); handle = null;
      await rename(temp, this.file);
      // Persist the rename on filesystems supporting directory fsync.
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await handle?.close(); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  // Claim BEFORE executing. This is at-most-once within the bounded retained
  // history, including crashes; ambiguous/failed input is never replayed.
  claim(ids) {
    const keys = [...new Set(ids.filter(Boolean))];
    return this.transaction(data => {
      if (!keys.length || keys.some(id => data.seen.includes(id))) return false;
      data.seen.push(...keys); data.seen = data.seen.slice(-this.dedupeLimit); return true;
    });
  }
  bind(binding) {
    return this.transaction(data => {
      if (data.bindings.some(b => b.topicId === binding.topicId || b.paneId === binding.paneId)) throw new Error('Topic or pane already bound');
      data.bindings.push({ ...binding, generation: randomUUID(), nonce: randomUUID() });
    });
  }
  update(chatId, topicId, patch) {
    return this.transaction(data => {
      const binding = data.bindings.find(b => b.chatId === chatId && b.topicId === topicId);
      if (!binding) throw new Error('Topic is no longer bound');
      Object.assign(binding, patch);
    });
  }
  consumeCard(chatId, topicId, cardId, nonce) {
    return this.transaction(data => {
      const b = data.bindings.find(b => b.chatId === chatId && b.topicId === topicId);
      if (!b || b.cardId !== cardId || b.nonce !== nonce) return false;
      b.nonce = randomUUID(); return true;
    });
  }
  actionCard(messageId) { return structuredClone(this.data.actionCards?.find(c => c.messageId === messageId)); }
  saveActionCard(card, now) {
    return this.transaction(data => {
      data.actionCards = (data.actionCards ?? []).filter(c => c.messageId !== card.messageId && now - c.createdAt < 600000);
      data.actionCards.push(card);
    });
  }
  consumeActionCard(card) {
    return this.transaction(data => {
      const index = (data.actionCards ?? []).findIndex(c => c.messageId === card.messageId && c.nonce === card.nonce);
      if (index < 0) return false;
      data.actionCards.splice(index, 1); return true;
    });
  }
  unbind(chatId, topicId) {
    return this.transaction(data => { data.bindings = data.bindings.filter(b => !(b.chatId === chatId && b.topicId === topicId)); });
  }
}

export function auditRecord({ openId, topicId, paneId, action, text = '' }) {
  return { time: new Date().toISOString(), open_id: openId, topic: topicId ?? null, pane: paneId ?? null,
    action, length: Buffer.byteLength(text), hash: createHash('sha256').update(text).digest('hex') };
}
export async function appendAudit(file, record) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 });
}
