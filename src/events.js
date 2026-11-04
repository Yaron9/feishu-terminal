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

// Both the native WS dispatcher and SDK callbacks may flatten the envelope.
export const eventTypes = Object.freeze(['im.message.receive_v1', 'card.action.trigger']);
export const cardOwner = 'feishu-terminal';
export function normalizeEvent(raw, botOpenId) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.header?.event_type ?? raw.event?.type ?? raw.event_type;
  if (type === eventTypes[0]) return messageEvent(raw, botOpenId);
  if (type === eventTypes[1]) {
    if ((raw.event ?? raw).action?.value?.ft_bridge !== cardOwner) return null;
    return actionEvent(raw);
  }
  return null;
}

// Apply at the transport boundary, including replayed cards from old state.
export function markCard(card) {
  if (!card || typeof card !== 'object') return card;
  const copy = structuredClone(card);
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if ((node.tag === 'button' || node.tag === 'interactive_container' || node.type === 'callback') && node.value)
      node.value.ft_bridge = cardOwner;
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value);
  };
  visit(copy);
  return copy;
}
