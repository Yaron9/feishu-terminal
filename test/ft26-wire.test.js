import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Feishu } from '../src/feishu.js';
import { FeishuAPI } from '../src/feishu-api.js';
import { FeishuWSClient } from '../src/feishu-ws.js';
import { encodeFrame, decodeFrame } from '../src/feishu-frame.js';
import { eventually } from './helpers.js';

// Tiny local RFC6455 peer, so this exercises the real Node fetch/WebSocket
// transports without loading ws, the SDK, credentials or external services.
test('real built-in fetch and WebSocket discover, ping, receive multipart events, toast ACK and send a reply', { timeout: 5000 }, async t => {
  const requests = [], frames = [], events = [], sockets = new Set();
  let base;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ url: request.url, body, auth: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/callback/ws/endpoint') response.end(JSON.stringify({ code: 0, data: {
      URL: base.replace('http:', 'ws:') + '/socket?device_id=local&service_id=7',
      ClientConfig: { PingInterval: 30, ReconnectCount: 2, ReconnectInterval: 1, ReconnectNonce: 1 },
    } }));
    else if (request.url.includes('/tenant_access_token/')) response.end(JSON.stringify({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 }));
    else response.end(JSON.stringify({ code: 0, data: { message_id: 'reply-id' } }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = frame => {
      const bytes = encodeFrame(frame), header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
      header[0] = 0x82; header[1] = bytes.length < 126 ? bytes.length : 126;
      if (bytes.length >= 126) header.writeUInt16BE(bytes.length, 2);
      socket.write(Buffer.concat([header, bytes]));
    };
    let buffered = Buffer.alloc(0), initiated = false;
    socket.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 2) {
        let length = buffered[1] & 127, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        assert.notEqual(length, 127);
        assert.ok(buffered[1] & 128, 'client frames are masked');
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4), payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        const opcode = buffered[0] & 15;
        buffered = buffered.subarray(offset + 4 + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 2) continue;
        const frame = decodeFrame(payload); frames.push(frame);
        if (frame.method === 0 && !initiated) {
          initiated = true;
          send({ ...frame, headers: [{ key: 'type', value: 'pong' }], payload: Buffer.from('{"PingInterval":10}') });
          const raw = Buffer.from(JSON.stringify({ schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'wire-card' },
            event: { operator: { open_id: 'operator' }, context: { open_chat_id: 'chat', open_message_id: 'card' },
              action: { value: { key: 'enter', topic_id: 'topic' } } } }));
          const split = Math.floor(raw.length / 2);
          for (const seq of [1, 0]) send({ SeqID: 18446744073709551615n, LogID: 9223372036854775808n, service: 7, method: 1,
            headers: Object.entries({ type: 'card', message_id: 'wire', seq: String(seq), sum: '2' }).map(([key, value]) => ({ key, value })),
            payload: seq ? raw.subarray(split) : raw.subarray(0, split) });
        }
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const ws = new FeishuWSClient({ appId: 'id', appSecret: 'secret', base });
  const edge = new Feishu({ client: new FeishuAPI({ appId: 'id', appSecret: 'secret', base }), ws });
  t.after(async () => { edge.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await edge.start(event => events.push(event));
  await eventually(() => frames.some(frame => frame.method === 1));
  assert.equal(events.length, 1); assert.equal(events[0].eventId, 'wire-card'); assert.equal(events[0].key, 'enter');
  const ackFrame = frames.find(frame => frame.method === 1), ack = JSON.parse(ackFrame.payload);
  assert.equal(ackFrame.SeqID, 18446744073709551615n); assert.equal(ack.code, 200);
  assert.deepEqual(JSON.parse(Buffer.from(ack.data, 'base64')), { toast: { type: 'info', content: '已收到，处理中…' } });
  assert.equal(ws.config.pingInterval, 10000);
  assert.equal(await edge.reply('topic', '中文🙂', 'text', 'wire-uuid'), 'reply-id');
  const reply = requests.find(request => request.url.endsWith('/topic/reply'));
  assert.equal(reply.auth, 'Bearer fixture-token'); assert.equal(reply.body.uuid, 'wire-uuid');
  assert.equal(reply.body.content, JSON.stringify({ text: '中文🙂' }));
});
