import { markCard } from './events.js';

/**
 * The core uses only these Feishu operations. The host owns connections.
 * All methods return promises and must propagate failures (no blind mutation retries).
 * @typedef {Object} Transport
 * @property {(chatId: string, content: string|Object, uuid?: string) => Promise<string>} send A bot root post creates a topic.
 * @property {(topicId: string, content: string|Object, type?: string, uuid?: string) => Promise<string>} reply Reply in thread; default type is text.
 * @property {(messageId: string, card: Object) => Promise<unknown>} patch Update cards, titles and retire old cards.
 * @property {(messageId: string) => Promise<Object>} getMessage Fetch root metadata for recovery.
 * @property {string} [botOpenId] Own mention identity, supplied by the host or built-in transport.
 *
 * No resource download, chat-info, delete or separate topic API is used by the core.
 * threadMessages is a standalone selftest helper, not a required core operation.
 */
export function bridgeTransport(transport) {
  for (const method of ['send', 'reply', 'patch', 'getMessage'])
    if (typeof transport?.[method] !== 'function') throw new TypeError(`Missing transport.${method}`);
  return {
    send: (chatId, content, uuid) => transport.send(chatId, markCard(content), uuid),
    reply: (topicId, content, type, uuid) => transport.reply(topicId, markCard(content), type, uuid),
    patch: (id, card) => transport.patch(id, markCard(card)),
    getMessage: id => transport.getMessage(id),
  };
}
