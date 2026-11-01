import test from 'node:test';
import assert from 'node:assert/strict';
import { Feishu, FeishuWSClient, quietLogger, messageEvent, actionEvent } from '../src/feishu.js';
import { eventually } from './helpers.js';

test('mention-only fallback strips only this bot initial marker and preserves other users and following payload', async () => {
  const raw = { message: { message_type: 'text', content: JSON.stringify({ text: '@_user_1 /t raw   exact  ' }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] } };
  assert.equal(messageEvent(raw, 'ou_bot').text, '/t raw   exact  ');
  assert.equal(messageEvent(raw, 'ou_other').text, '@_user_1 /t raw   exact  ');
  const seen = []; let handler, lookups = 0;
  const ws = { start({ eventDispatcher }) { handler = eventDispatcher; }, close() {} };
  const client = { request: async payload => { lookups++; assert.equal(payload.url, '/open-apis/bot/v3/info'); return { code: 0, bot: { open_id: 'ou_bot' } }; } };
  const edge = new Feishu({ client, ws });
  await edge.start(event => seen.push(event));
  await handler.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event: raw });
  await eventually(() => seen.length === 1);
  assert.equal(seen[0].text, '/t raw   exact  '); assert.equal(lookups, 1); edge.close();
});

test('SDK edge normalizes actual event envelopes and flattened SDK handler payloads without altering text', () => {
  const event = { sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' },
    message: { message_id: 'm2', root_id: 'm1', parent_id: 'child', chat_id: 'oc_a', chat_type: 'topic_group', message_type: 'text', content: JSON.stringify({ text: '/compact\n  ' }) } };
  const result = messageEvent({ header: { event_id: 'e1' }, event });
  assert.equal(result.text, '/compact\n  '); assert.equal(result.topicId, 'm1'); assert.equal(result.isReply, true);
  assert.equal(messageEvent({ event_id: 'e2', ...event }).eventId, 'e2');
  assert.equal(messageEvent({ ...event, message: { ...event.message, content: '{bad' } }).text, undefined);
  const button = actionEvent({ header: { event_id: 'e3' }, event: { operator: { open_id: 'ou_a' }, token: 'token',
    context: { open_message_id: 'card', open_chat_id: 'oc_a' }, action: { value: { topic_id: 'm1', nonce: 'nonce', key: 'enter' } } } });
  assert.equal(button.messageId, 'card'); assert.equal(button.key, 'enter'); assert.equal(button.callbackToken, 'token');
});

test('send/reply/patch use official SDK fields, thread replies, JSON content and stable UUID on rate-limit retry', async () => {
  const calls = []; let retries = 0;
  const client = { im: { message: {
    create: async payload => { calls.push(['create', payload]); return { code: 0, data: { message_id: 'root' } }; },
    reply: async payload => {
      calls.push(['reply', payload]);
      if (retries++ === 0) return { code: 99991400 };
      return { code: 0, data: { message_id: 'reply' } };
    },
    patch: async payload => { calls.push(['patch', payload]); return { code: 0, data: {} }; },
  } } };
  const edge = new Feishu({ client, ws: { close() {} } });
  assert.equal(await edge.send('oc_a', 'hello'), 'root');
  assert.equal(await edge.reply('root', 'literal  \n中文', 'text', 'stable-uuid'), 'reply');
  await edge.patch('reply', { elements: [] });
  assert.equal(calls[0][1].params.receive_id_type, 'chat_id');
  assert.equal(calls[1][1].data.reply_in_thread, true);
  assert.equal(calls[1][1].data.content, JSON.stringify({ text: 'literal  \n中文' }));
  assert.equal(calls[1][1].data.uuid, calls[2][1].data.uuid);
  assert.equal(calls[3][1].path.message_id, 'reply');
});

test('SDK API transport errors are sanitized and ambiguous sends are not retried', async () => {
  let count = 0;
  const edge = new Feishu({ client: { im: { message: { create: async () => { count++; throw new Error('secret token typed input'); } } } }, ws: { close() {} } });
  await assert.rejects(edge.send('oc_a', 'text'), error => error.code === 'network_error' && !error.message.includes('secret'));
  assert.equal(count, 1);
});

test('SDK HTTP errors preserve definite card failure codes for replacement', async () => {
  const edge = new Feishu({ client: { im: { message: { patch: async () => {
    throw { response: { status: 400, data: { code: 230011 } } };
  } } } }, ws: { close() {} } });
  await assert.rejects(edge.patch('gone', {}), error => error.code === '230011');
});

test('failed bot identity lookup rejects delivery instead of acknowledging unclaimed input', async () => {
  let dispatcher, delivered = false;
  const edge = new Feishu({ client: { request: async () => { throw new Error('offline'); } },
    ws: { start({ eventDispatcher }) { dispatcher = eventDispatcher; }, close() {} } });
  await edge.start(() => { delivered = true; });
  await assert.rejects(dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1' },
    event: { message: { mentions: [{ key: '@_bot', id: { open_id: 'ou_bot' } }], message_type: 'text', content: '{"text":"@_bot pwd"}' } } }));
  assert.equal(delivered, false);
});

test('SDK message and card ACK waits for durable claim but not execution; card type survives compatibility shim', async () => {
  const seen = [], acknowledgements = [];
  const ws = new FeishuWSClient({ appId: 'fixture', appSecret: 'fixture', logger: quietLogger });
  // No network: capture the pinned SDK encoder output at its websocket boundary.
  ws.wsConfig.getWSInstance = () => ({ readyState: 1, send(bytes, callback) { acknowledgements.push(bytes); callback?.(); } });
  const edge = new Feishu({ client: {}, ws: { start({ eventDispatcher }) { ws.eventDispatcher = eventDispatcher; }, close() {} } });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await edge.start(async event => { seen.push(event); await pending; });
  const frame = (type, eventType, id, event) => ({ method: 1, service: 1, SeqID: '1', LogID: '1', headers: [
    { key: 'type', value: type }, { key: 'message_id', value: id }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' },
  ], payload: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_type: eventType, event_id: id }, event })) });
  const messageDelivery = ws.handleEventData(frame('event', 'im.message.receive_v1', 'e1', {
    sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' }, message: { message_id: 'm1', chat_id: 'oc_a', message_type: 'text', content: '{"text":"pwd"}' },
  }));
  const cardDelivery = ws.handleEventData(frame('card', 'card.action.trigger', 'e2', {
    operator: { open_id: 'ou_a' }, context: { open_message_id: 'card', open_chat_id: 'oc_a' },
    action: { value: { topic_id: 'm1', nonce: 'nonce', key: 'enter' } },
  }));
  await eventually(() => seen.length === 2);
  assert.equal(acknowledgements.length, 0); // durable claim is still pending
  release(); await Promise.all([messageDelivery, cardDelivery]);
  await eventually(() => acknowledgements.length === 2);
  assert.equal(seen[0].text, 'pwd'); assert.equal(seen[0].eventId, 'e1');
  assert.equal(seen[1].kind, 'button'); assert.equal(seen[1].eventId, 'e2');
  // Protobuf strings are length-delimited but remain plain bytes in the ACK.
  assert.ok(acknowledgements[1].includes(Buffer.from('card')));
  assert.ok(!acknowledgements[1].includes(Buffer.from('event')));
  assert.ok(acknowledgements[1].includes(Buffer.from('"code":200')));
  release(); edge.close(); ws.wsConfig.getWSInstance = () => undefined; ws.close({ force: true });
});
