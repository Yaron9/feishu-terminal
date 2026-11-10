import { mkdir, open, readFile, rename, appendFile, unlink, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class Store {
  constructor(file, { dedupeLimit = 10000, cardSchemaLimit = 4096, now = Date.now } = {}) {
    Object.assign(this, { file, dedupeLimit, cardSchemaLimit, now });
    this.data = { version: 2, bindings: [], seen: [] }; this.queue = Promise.resolve();
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (![1, 2].includes(data.version) || !Array.isArray(data.bindings) || !Array.isArray(data.seen)) throw new Error('Invalid bridge state');
      const topics = new Set(), panes = new Set();
      for (const b of data.bindings) {
        if (!b.chatId || !b.topicId || !b.paneId || topics.has(b.topicId) || panes.has(b.paneId)) throw new Error('Invalid bindings');
        topics.add(b.topicId); panes.add(b.paneId);
      }
      if (data.version === 1) {
        // Never overwrite the first pre-migration snapshot on subsequent loads.
        try { await copyFile(this.file, this.file + '.v1.bak', constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        data.version = 2;
        for (const b of data.bindings) {
          b.dormant ??= false;
          b.cli ??= null;
          b.cwd ??= null;
          b.sessionId ??= b.claudeSessionId ?? null;
        }
        await this.write(data);
      }
      let sanitized = false;
      const unsafe = new Set(data.bindings.filter(b => ['codex', 'pi'].includes(b.cli) && b.sessionId && b.sessionSource !== 'verified' &&
        data.bindings.some(other => other !== b && ['codex', 'pi'].includes(other.cli) && other.sessionId === b.sessionId && other.sessionSource !== 'verified') &&
        !data.bindings.some(other => other.sessionId === b.sessionId && other.sessionSource === 'verified')).map(b => b.sessionId));
      for (const b of data.bindings) if (['codex', 'pi'].includes(b.cli) && b.sessionId &&
        unsafe.has(b.sessionId)) {
        b.sessionId = null; b.sessionSource = null; b.sessionVerified = false; b.sessionHandoff = null; b.sessionReplay = true; sanitized = true;
      }
      if (sanitized) await this.write(data);
      this.data = data;
      this.prune(this.data);
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
      this.prune(next);
      await this.write(next); this.data = next; return value;
    });
    this.queue = result.catch(() => {}); return result;
  }
  prune(data) {
    data.seen = data.seen.slice(-this.dedupeLimit);
    if (data.actionCards) {
      const inTopic = card => !card.spent && (card.inTopic || data.bindings.some(b => b.chatId === card.chatId && b.topicId === card.topicId));
      const management = new Set(data.actionCards.filter(card => !inTopic(card)).slice(-512));
      data.actionCards = data.actionCards.filter(card => inTopic(card) || management.has(card));
    }
    if (data.topicPointers) data.topicPointers = data.topicPointers.slice(-10000);
    if (data.createdTerminals) {
      // Forgetting old ownership only restores desktop-close confirmation.
      const active = data.bindings.map(b => b.identity?.terminalId).filter(Boolean);
      data.createdTerminals = [...new Set([...data.createdTerminals.slice(-10000), ...active])];
    }
    if (!data.cardSchemas) return;
    const live = new Set();
    const visit = object => {
      for (const [key, value] of Object.entries(object ?? {})) {
        if (typeof value === 'string' && /(?:cardId|messageId|topicId|targetId)$/i.test(key)) live.add(value);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(data.bindings); visit(data.actionCards);
    const now = this.now(); let inactive = 0;
    for (const id in data.cardSchemas) {
      const metadata = data.cardSchemas[id];
      // Give legacy entries one retention window at migration. Live/pending
      // cards are pinned: schema choice must survive long-lived bindings.
      metadata.updatedAt ??= now;
      if (live.has(id)) continue;
      if (now - metadata.updatedAt >= 14 * 86400000) delete data.cardSchemas[id];
      else inactive++;
    }
    // Writers move touched IDs to the end. Evict by insertion order without
    // allocating/sorting thousands of temporary pairs on every transaction.
    for (const id in data.cardSchemas) {
      if (inactive <= this.cardSchemaLimit) break;
      if (!live.has(id)) { delete data.cardSchemas[id]; inactive--; }
    }
  }
  maintain(actionNow) {
    return this.transaction(() => {});
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
    // A known rejection needs no write. In particular, a loaded observer must
    // not replace newer persisted state just to reject an already claimed ID.
    if (!keys.length || keys.some(id => this.data.seen.includes(id))) return Promise.resolve(false);
    return this.transaction(data => {
      if (!keys.length || keys.some(id => data.seen.includes(id))) return false;
      data.seen.push(...keys); data.seen = data.seen.slice(-this.dedupeLimit); return true;
    });
  }
  bind(binding) {
    return this.transaction(data => {
      if (data.bindings.some(b => b.topicId === binding.topicId || b.paneId === binding.paneId)) throw new Error('Topic or pane already bound');
      data.bindings.push({ ...binding, generation: randomUUID(), nonce: randomUUID() });
      if (binding.tree) data.treeSeen = [...new Set([...(data.treeSeen ?? []), binding.identity.terminalId])];
    });
  }
  update(chatId, topicId, patch) {
    return this.transaction(data => {
      const binding = data.bindings.find(b => b.chatId === chatId && b.topicId === topicId);
      if (!binding) throw new Error('Topic is no longer bound');
      Object.assign(binding, patch);
    });
  }
  consumeCard(chatId, topicId, cardId, nonce, menu = false) {
    return this.transaction(data => {
      const b = data.bindings.find(b => b.chatId === chatId && b.topicId === topicId);
      const idKey = menu ? 'menuCardId' : 'cardId', nonceKey = menu ? 'menuNonce' : 'nonce';
      if (!b || b[idKey] !== cardId || b[nonceKey] !== nonce) return false;
      b[nonceKey] = randomUUID(); return true;
    });
  }
  actionCard(messageId) { return structuredClone(this.data.actionCards?.find(c => c.messageId === messageId)); }
  saveActionCard(card, now) {
    return this.transaction(data => {
      data.actionCards = (data.actionCards ?? []).filter(c => c.messageId !== card.messageId);
      data.actionCards.push(card);
    });
  }
  consumeActionCard(card) {
    return this.transaction(data => {
      const index = (data.actionCards ?? []).findIndex(c => c.messageId === card.messageId && c.nonce === card.nonce);
      if (index < 0 || data.actionCards[index].spent) return false;
      data.actionCards[index].spent = true; return true;
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
