import { randomUUID } from 'node:crypto';

// Alerts use the configured bot and the same serialized API queue as the bridge.
export function createOperatorNotifier(transport, openId) {
  if (!/^ou_[A-Za-z0-9]+$/.test(openId ?? '')) throw new Error('operator unavailable');
  return async text => {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('invalid alert');
    const uuid = randomUUID();
    const data = await transport.api(() => transport.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }), uuid },
    }));
    if (!data?.message_id) throw new Error('alert not confirmed');
  };
}
