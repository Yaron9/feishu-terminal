import * as lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';

// The pinned SDK logs request bodies/errors, which can include credentials or
// terminal data. Replace its logger entirely; bridge logs only safe codes.
export const quietLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

const cardFrame = Symbol('cardFrame');
// SDK 1.76.0 handleEventData drops type=card frames. Reuse its fragmentation,
// dispatcher and acknowledgement path, restoring the original ACK frame type.
// This small, version-pinned compatibility shim is exercised with SDK frames.
export class FeishuWSClient extends lark.WSClient {
  handleEventData(frame) {
    if (!frame.headers.some(h => h.key === 'type' && h.value === 'card')) return super.handleEventData(frame);
    return super.handleEventData({ ...frame, [cardFrame]: true,
      headers: frame.headers.map(h => h.key === 'type' ? { ...h, value: 'event' } : h) });
  }
  sendMessage(frame) {
    if (frame[cardFrame]) frame = { ...frame, headers: frame.headers.map(h => h.key === 'type' ? { ...h, value: 'card' } : h) };
    return super.sendMessage(frame);
  }
}

export function messageEvent(raw, botOpenId) {
  const event = raw.event ?? raw;
  const message = event.message ?? {};
  let text;
  if (message.message_type === 'text') {
    try { text = JSON.parse(message.content).text; } catch { /* unsupported */ }
  }
  if (botOpenId && typeof text === 'string') {
    const mentions = (message.mentions ?? []).filter(m => typeof m.key === 'string' && m.key);
    const ownKeys = new Set(mentions.filter(m => m.id?.open_id === botOpenId).map(m => m.key));
    if (ownKeys.size) {
      // Match all entities longest-first so another user's key cannot match a bot-key prefix.
      const keys = [...new Set(mentions.map(m => m.key))].sort((a, b) => b.length - a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const matches = [...text.matchAll(new RegExp(keys.join('|'), 'g'))].filter(match => ownKeys.has(match[0]));
      for (const match of matches.reverse()) {
        let left = match.index, right = left + match[0].length;
        while (left > 0 && /[ \t]/.test(text[left - 1])) left--;
        while (right < text.length && /[ \t]/.test(text[right])) right++;
        const separator = left > 0 && right < text.length && (left < match.index || right > match.index + match[0].length) ? ' ' : '';
        text = text.slice(0, left) + separator + text.slice(right);
      }
    }
  }
  return { kind: 'message', eventId: raw.header?.event_id ?? raw.event_id,
    messageId: message.message_id, chatId: message.chat_id, chatType: message.chat_type,
    openId: event.sender?.sender_id?.open_id, senderType: event.sender?.sender_type,
    topicId: message.root_id || message.parent_id || message.message_id,
    isReply: Boolean(message.root_id || message.parent_id), text,
    ...(message.create_time ? { createdAt: Number(message.create_time) } : {}) };
}

export function actionEvent(raw) {
  const event = raw.event ?? raw;
  return { kind: 'button', eventId: raw.header?.event_id ?? raw.event_id,
    // A callback token identifies a delivery if a platform event_id is absent.
    callbackToken: event.token,
    openId: event.operator?.open_id, chatId: event.context?.open_chat_id ?? event.open_chat_id,
    messageId: event.context?.open_message_id ?? event.open_message_id,
    topicId: event.action?.value?.topic_id, nonce: event.action?.value?.nonce, key: event.action?.value?.key };
}

export class FeishuError extends Error {
  constructor(code, retryAfterMs = 1000, detail) {
    super('Feishu request failed'); this.code = String(code); this.retryAfterMs = retryAfterMs;
    // Keep generic errors sanitized; retirement explicitly logs this diagnostic.
    this.detail = detail;
  }
}

export class Feishu {
  constructor({ appId, appSecret, client, ws, logger = quietLogger } = {}) {
    this.client = client ?? new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu, logger });
    this.ws = ws ?? new FeishuWSClient({ appId, appSecret, domain: lark.Domain.Feishu, logger });
    this.sendQueue = Promise.resolve(); this.nextSend = 0;
  }
  async start(onEvent, onError = () => {}) {
    const deliver = async event => {
      try { await onEvent(event); }
      catch (error) { onError('event_failed'); throw error; } // no successful ACK if the claim failed
    };
    this.dispatcher = new lark.EventDispatcher({ logger: quietLogger }).register({
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
        await deliver(messageEvent(raw, this.botOpenId));
      },
      'card.action.trigger': async raw => {
        await deliver(actionEvent(raw));
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
    const items = []; let pageToken;
    do {
      const data = await this.api(() => this.client.im.message.list({ params: {
        container_id_type: 'thread', container_id: threadId, page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      } }));
      items.push(...(data?.items ?? []));
      if (data?.has_more && (!data.page_token || data.page_token === pageToken)) throw new FeishuError('invalid_pagination');
      pageToken = data?.has_more ? data.page_token : null;
    } while (pageToken);
    return items;
  }
}
