import { FeishuAPI } from './feishu-api.js';
import { FeishuWSClient, EventDispatcher } from './feishu-ws.js';
export { FeishuWSClient } from './feishu-ws.js';
import { randomUUID } from 'node:crypto';

// Neither native transport logs request bodies, credentials or terminal data.
export const quietLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

import { messageEvent, actionEvent } from './events.js';
export { messageEvent, actionEvent } from './events.js';

export class FeishuError extends Error {
  constructor(code, retryAfterMs = 1000, detail) {
    super('Feishu request failed'); this.code = String(code); this.retryAfterMs = retryAfterMs;
    // Keep generic errors sanitized; retirement explicitly logs this diagnostic.
    this.detail = detail;
  }
}

export class Feishu {
  constructor({ appId, appSecret, client, ws, logger = quietLogger } = {}) {
    this.client = client ?? new FeishuAPI({ appId, appSecret });
    this.ws = ws ?? new FeishuWSClient({ appId, appSecret, logger });
    this.sendQueue = Promise.resolve(); this.nextSend = 0;
  }
  async start(onEvent, onError = () => {}, { rawEvents = false } = {}) {
    const deliver = async event => {
      try { await onEvent(event); }
      catch (error) { onError('event_failed'); throw error; } // no successful ACK if the claim failed
    };
    this.dispatcher = new EventDispatcher().register({
      'im.message.receive_v1': async raw => {
        const message = (raw.event ?? raw).message;
        if (message?.mentions?.length) {
          try {
            if (!this.botOpenId) {
              const data = await this.api(async () => {
                const response = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
                return { code: response.code, data: response.bot };
              });
              if (!data?.open_id) throw new FeishuError('missing_bot_identity');
              this.botOpenId = data.open_id;
            }
          } catch { onError('bot_identity_failed'); throw new FeishuError('bot_identity_failed'); }
        }
        await deliver(rawEvents ? raw : messageEvent(raw, this.botOpenId));
      },
      'card.action.trigger': async raw => {
        await deliver(rawEvents ? raw : actionEvent(raw));
        // Only the local claim is awaited inside Feishu's callback deadline.
        return { toast: { type: 'info', content: '已收到，处理中…' } };
      },
    });
    await this.ws.start({ eventDispatcher: this.dispatcher });
  }
  close() { this.ws.close({ force: true }); }

  // Serialize all API calls and keep below the shared group 5 QPS ceiling.
  // Retry only explicit throttling responses; UUIDs protect message sends.
  api(call) {
    const operation = this.sendQueue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const delay = this.nextSend - Date.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        this.nextSend = Date.now() + 250;
        let response;
        try { response = await call(); }
        catch (error) {
          const status = error.response?.status;
          const code = error.response?.data?.code;
          if ((status === 429 || code === 99991400 || code === 230020) && attempt < 4) {
            this.nextSend = Date.now() + Math.max(1000 * 2 ** attempt, Math.min(30000, Number(error.response?.headers?.['retry-after'] || 0) * 1000));
            continue;
          }
          throw new FeishuError(code ?? status ?? error.code ?? 'network_error', 1000, error.response?.data?.msg ?? error.message);
        }
        if (response.code && response.code !== 0) {
          if ([99991400, 230020].includes(response.code) && attempt < 4) {
            this.nextSend = Date.now() + 1000 * 2 ** attempt; continue;
          }
          throw new FeishuError(response.code, 1000, response.msg);
        }
        return response.data;
      }
    });
    this.sendQueue = operation.catch(() => {}); return operation;
  }
  async send(chatId, text, uuid = randomUUID()) {
    const data = await this.api(() => this.client.im.message.create({ params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: typeof text === 'string' ? 'text' : 'interactive', content: JSON.stringify(typeof text === 'string' ? { text } : text), uuid } }));
    if (!data?.message_id) throw new FeishuError('missing_message_id');
    return data.message_id;
  }
  async reply(topicId, content, type = 'text', uuid = randomUUID()) {
    const data = await this.api(() => this.client.im.message.reply({ path: { message_id: topicId },
      data: { msg_type: type, content: JSON.stringify(type === 'text' ? { text: content } : content), reply_in_thread: true, uuid } }));
    if (!data?.message_id) throw new FeishuError('missing_message_id');
    return data.message_id;
  }
  patch(messageId, card) {
    return this.api(() => this.client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } }));
  }
  async getMessage(messageId) {
    const data = await this.api(() => this.client.im.message.get({ path: { message_id: messageId } }));
    const message = data?.items?.find(item => item.message_id === messageId);
    if (!message) throw new FeishuError('missing_message');
    return message;
  }
  async threadMessages(threadId) {
    const items = [], pages = new Set(); let pageToken;
    do {
      const data = await this.api(() => this.client.im.message.list({ params: {
        container_id_type: 'thread', container_id: threadId, page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      } }));
      items.push(...(data?.items ?? []));
      if (data?.has_more && (!data.page_token || pages.has(data.page_token))) throw new FeishuError('invalid_pagination');
      if (items.length > 5000 || (data?.has_more && pages.size >= 99)) throw new FeishuError('thread_history_limit');
      pageToken = data?.has_more ? data.page_token : null;
      if (pageToken) pages.add(pageToken);
    } while (pageToken);
    return items;
  }
}
