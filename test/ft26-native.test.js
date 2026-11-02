import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FeishuAPI } from '../src/feishu-api.js';
import { Feishu, FeishuError } from '../src/feishu.js';
import { FeishuWSClient, EventDispatcher, FragmentCache } from '../src/feishu-ws.js';
import { encodeFrame, decodeFrame } from '../src/feishu-frame.js';
import { eventually } from './helpers.js';

const json = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers });
const frame = (type, payload, extra = {}) => ({ SeqID: 9n, LogID: 18446744073709551615n, service: 7, method: 1,
  headers: Object.entries({ type, message_id: 'message', sum: '1', seq: '0', ...extra }).map(([key, value]) => ({ key, value })),
  payload: Buffer.from(JSON.stringify(payload)) });

test('bin, runtime, setup and selftest imports load no SDK anywhere in the ESM or CommonJS graph', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks, createRequire } from 'node:module';
    import assert from 'node:assert/strict';
    const loaded = [];
    registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
    process.argv = ['node', 'bin/feishu-terminal.js', '--help'];
    for (const file of ['bin/feishu-terminal.js', 'src/runtime.js', 'src/setup.js', 'src/selftest.js']) await import('./' + file);
    assert(loaded.some(url => url.endsWith('/src/feishu-ws.js')));
    assert(!loaded.some(url => url.includes('@larksuiteoapi')));
    assert(!Object.keys(createRequire(import.meta.url).cache).some(url => url.includes('@larksuiteoapi')));
    console.log('SDK_FREE');
  `], { cwd: new URL('..', import.meta.url), timeout: 10000 });
  assert.match(stdout, /SDK_FREE/);
});

test('tenant tokens refresh three minutes early, coalesce concurrent refreshes and recover after a failed refresh', async () => {
  let time = 0, tokens = 0, fail = false;
  const api = new FeishuAPI({ appId: 'id', appSecret: 'secret', now: () => time,
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/tenant_access_token/internal'));
      assert.deepEqual(JSON.parse(init.body), { app_id: 'id', app_secret: 'secret' });
      tokens++;
      if (fail) return json({ code: 10003, msg: 'bad credential' });
      return json({ code: 0, tenant_access_token: `token-${tokens}`, expire: 7200 });
    } });
  assert.deepEqual(await Promise.all([api.tenantToken(), api.tenantToken()]), ['token-1', 'token-1']);
  time = 7019999; assert.equal(await api.tenantToken(), 'token-1');
  time++; assert.equal(await api.tenantToken(), 'token-2'); assert.equal(tokens, 2);
  time += 7020000; fail = true;
  await assert.rejects(api.tenantToken());
  fail = false; assert.equal(await api.tenantToken(), 'token-4');
});

test('native endpoints send SDK-compatible methods, escaped IDs, pagination and bot lookup with cached authorization', async () => {
  const calls = [];
  const api = new FeishuAPI({ fetchImpl: async (url, init) => {
    calls.push({ url, ...init });
    return json(url.includes('/tenant_access_token/') ? { code: 0, tenant_access_token: 'cached', expire: 7200 } :
      { code: 0, data: { message_id: 'sent', items: [{ message_id: 'sent' }] } });
  } });
  const edge = new Feishu({ client: api, ws: { close() {} } });
  const invoke = async fn => { edge.nextSend = 0; return fn(); };
  await invoke(() => edge.send('chat', 'text', 'stable'));
  await invoke(() => edge.reply('root/?', 'reply', 'text', 'stable-reply'));
  await invoke(() => edge.patch('card/?', { schema: '2.0' }));
  await invoke(() => edge.getMessage('sent'));
  await invoke(() => edge.threadMessages('thread'));
  await api.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
  assert.equal(calls.filter(c => c.url.includes('/tenant_access_token/')).length, 1);
  const rest = calls.filter(c => !c.url.includes('/tenant_access_token/'));
  assert.deepEqual(rest.map(c => c.method), ['POST', 'POST', 'PATCH', 'GET', 'GET', 'GET']);
  assert.ok(rest.every(c => c.headers.Authorization === 'Bearer cached'));
  assert.match(rest[0].url, /messages\?receive_id_type=chat_id$/);
  assert.equal(JSON.parse(rest[0].body).uuid, 'stable');
  assert.match(rest[1].url, /root%2F%3F\/reply$/);
  assert.equal(JSON.parse(rest[1].body).reply_in_thread, true);
  assert.match(rest[2].url, /card%2F%3F$/);
  assert.match(rest[4].url, /container_id_type=thread&container_id=thread&page_size=50$/);
});

test('native transport keeps ft21 code/msg diagnostics and sanitized public errors without retrying ambiguous sends', async () => {
  for (const [status, body, expected, detail] of [[400, { code: 230099, msg: 'ErrCode: 200830' }, '230099', 'ErrCode: 200830'],
    [200, { code: 230011, msg: 'message gone' }, '230011', 'message gone'], [503, {}, '503', 'Feishu HTTP request failed']]) {
    const api = new FeishuAPI({ fetchImpl: async url => url.includes('/tenant_access_token/') ?
      json({ code: 0, tenant_access_token: 'token', expire: 7200 }) : json(body, status) });
    const edge = new Feishu({ client: api, ws: { close() {} } });
    await assert.rejects(edge.patch('id', {}), e => e instanceof FeishuError && e.code === expected && e.detail === detail && e.message === 'Feishu request failed');
  }
  let sends = 0;
  const api = new FeishuAPI({ fetchImpl: async url => {
    if (url.includes('/tenant_access_token/')) return json({ code: 0, tenant_access_token: 'token', expire: 7200 });
    sends++; throw new Error('SECRET request body');
  } });
  await assert.rejects(new Feishu({ client: api, ws: { close() {} } }).send('chat', 'SECRET'), e => e.code === 'network_error' && !JSON.stringify(e).includes('SECRET'));
  assert.equal(sends, 1);
});

test('HTTP 429 native responses preserve retry-after and stable UUID through existing throttle retry rules', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = []; let attempts = 0;
  const api = new FeishuAPI({ fetchImpl: async url => {
    if (url.includes('/tenant_access_token/')) return json({ code: 0, tenant_access_token: 't', expire: 7200 });
    if (++attempts === 1) return json({ code: 230020, msg: 'throttle' }, 429, { 'retry-after': '3' });
    return json({ code: 0, data: { message_id: 'sent' } });
  } });
  const original = api.json.bind(api);
  api.json = (url, options) => { if (options?.data?.uuid) sent.push(options.data.uuid); return original(url, options); };
  const edge = new Feishu({ client: api, ws: { close() {} } });
  const pending = edge.send('chat', 'text', 'stable');
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(attempts, 1);
  t.mock.timers.tick(2999); await Promise.resolve(); assert.equal(attempts, 1);
  t.mock.timers.tick(1); assert.equal(await pending, 'sent');
  assert.deepEqual(sent, ['stable', 'stable']);
});

test('native API deadline aborts fetch without replaying the message', async () => {
  const api = new FeishuAPI({ timeoutMs: 5, fetchImpl: async (url, init) => {
    assert.ok(init.signal);
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(resolve, 100);
      init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); }, { once: true });
    });
  } });
  await assert.rejects(api.tenantToken(), { code: 'network_error' });
});

test('fragment reassembly accepts out-of-order and duplicate UTF-8 chunks; ACK retains IDs and card toast', async () => {
  const ws = new FeishuWSClient(), sent = [], delivered = [];
  ws.sendMessage = value => sent.push(value);
  const edge = new Feishu({ client: {}, ws: { start({ eventDispatcher }) { ws.eventDispatcher = eventDispatcher; }, close() {} } });
  await edge.start(event => delivered.push(event));
  const full = frame('card', { schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'id' },
    event: { operator: { open_id: 'operator' }, action: { value: { key: '中文' } } } }, { sum: '3' });
  const pieces = [full.payload.subarray(0, 15), full.payload.subarray(15, full.payload.length - 3), full.payload.subarray(full.payload.length - 3)];
  const deliver = async seq => ws.handleEventData({ ...full, headers: full.headers.map(h => h.key === 'seq' ? { ...h, value: String(seq) } : h), payload: pieces[seq] });
  await deliver(2); await deliver(2); await deliver(0);
  assert.equal(delivered.length, 0); assert.equal(sent.length, 0);
  await deliver(1);
  assert.equal(delivered[0].key, '中文'); assert.equal(sent.length, 1);
  assert.equal(sent[0].LogID, 18446744073709551615n);
  assert.equal(sent[0].headers.find(h => h.key === 'type').value, 'card');
  const ack = JSON.parse(sent[0].payload);
  assert.equal(ack.code, 200);
  assert.deepEqual(JSON.parse(Buffer.from(ack.data, 'base64')), { toast: { type: 'info', content: '已收到，处理中…' } });
  assert.equal(ws.dataCache.bytes, 0); ws.close();
});

test('fragment cache expires and bounds counts, bytes and malformed metadata without retaining completed payloads', () => {
  let time = 0;
  const cache = new FragmentCache({ now: () => time, maxEntries: 2, maxBytes: 10, maxParts: 3 });
  for (let i = 0; i < 5; i++) cache.mergeData({ message_id: String(i), sum: 2, seq: 0, data: Buffer.from('x') });
  assert.equal(cache.cache.size, 2); assert.equal(cache.bytes, 2);
  assert.throws(() => cache.mergeData({ message_id: 'bad', sum: 9999, seq: 0, data: Buffer.alloc(1) }));
  assert.throws(() => cache.mergeData({ message_id: '4', sum: 3, seq: 0, data: Buffer.alloc(1) }));
  assert.throws(() => cache.mergeData({ message_id: 'large', sum: 2, seq: 0, data: Buffer.alloc(11) }));
  time = 10000; cache.prune(); assert.equal(cache.cache.size, 0); assert.equal(cache.bytes, 0);
  for (const seq of [-1, 2, NaN]) assert.throws(() => cache.mergeData({ message_id: 'bad', sum: 2, seq, data: Buffer.alloc(1) }));
});

class Socket {
  static sockets = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; Socket.sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(bytes) { this.sent.push(decodeFrame(bytes)); }
  close() { this.readyState = 3; this.onclose?.(); }
  message(frame) { return this.onmessage?.({ data: encodeFrame(frame) }); }
}
const endpoint = config => json({ code: 0, data: { URL: 'wss://fixture.invalid/ws?device_id=d&service_id=7',
  ClientConfig: { PingInterval: 30, ReconnectCount: 2, ReconnectInterval: 3, ReconnectNonce: 2, ...config } } });

test('endpoint config, initial ping, pong config updates, reconnect hooks/backoff and close cancel timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  Socket.sockets = []; const hooks = []; let pulls = 0;
  const ws = new FeishuWSClient({ appId: 'id', appSecret: 'secret', WebSocketImpl: Socket, random: () => .5,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://open.feishu.cn/callback/ws/endpoint');
      assert.equal(init.headers.locale, 'zh'); assert.ok(init.signal);
      assert.deepEqual(JSON.parse(init.body), { AppID: 'id', AppSecret: 'secret' });
      pulls++; return endpoint();
    }, onReady: () => hooks.push('ready'), onReconnecting: () => hooks.push('reconnecting'), onReconnected: () => hooks.push('reconnected') });
  t.after(() => ws.close());
  const starting = ws.start({ eventDispatcher: new EventDispatcher() });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  Socket.sockets[0].open(); await starting;
  assert.equal(ws.config.deviceId, 'd'); assert.deepEqual(hooks, ['ready']);
  assert.equal(Socket.sockets[0].sent[0].method, 0);
  assert.deepEqual(Socket.sockets[0].sent[0].headers, [{ key: 'type', value: 'ping' }]);
  await Socket.sockets[0].message({ ...frame('pong', { PingInterval: 5, ReconnectInterval: 4, ReconnectNonce: 6, ReconnectCount: 3 }), method: 0 });
  assert.equal(ws.config.pingInterval, 5000); assert.equal(ws.config.reconnectCount, 3);
  t.mock.timers.tick(30000); assert.equal(Socket.sockets[0].sent.length, 2);
  Socket.sockets[0].close(); assert.deepEqual(hooks, ['ready', 'reconnecting']);
  t.mock.timers.tick(2999); await Promise.resolve(); assert.equal(pulls, 1);
  t.mock.timers.tick(1);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  Socket.sockets[1].open();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(hooks, ['ready', 'reconnecting', 'reconnected']);
  assert.equal(ws.getConnectionStatus().state, 'connected');
  ws.close(); t.mock.timers.tick(1000000); await Promise.resolve();
  assert.equal(pulls, 2); assert.equal(ws.dataCache.cache.size, 0);
});

test('retryable endpoint errors respect retry count and interval; fatal credentials surface safe errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let pulls = 0; const errors = [];
  const ws = new FeishuWSClient({ random: () => 0, fetchImpl: async () => { pulls++; return json({ code: 1000040343 }); }, onError: e => errors.push(e.message) });
  t.after(() => ws.close());
  ws.updateConfig({ ReconnectCount: 2, ReconnectInterval: 1 });
  await ws.start({ eventDispatcher: new EventDispatcher() });
  t.mock.timers.tick(0); for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(pulls, 2); assert.equal(errors.length, 0);
  t.mock.timers.tick(999); await Promise.resolve(); assert.equal(pulls, 2);
  t.mock.timers.tick(1); for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(pulls, 3); assert.deepEqual(errors, ['ws_reconnect_exhausted']);
  assert.equal(ws.getConnectionStatus().state, 'failed');
  ws.fetchImpl = async () => json({ code: 514, msg: 'SECRET' });
  await ws.start({ eventDispatcher: new EventDispatcher() });
  assert.deepEqual(errors, ['ws_reconnect_exhausted', 'ws_endpoint_514']);
});

test('close during discovery and during handshake cannot resurrect a socket; a later start works', async () => {
  let release;
  Socket.sockets = [];
  const ws = new FeishuWSClient({ WebSocketImpl: Socket, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = ws.start({ eventDispatcher: new EventDispatcher() });
  ws.close(); release(endpoint()); await pending; assert.equal(Socket.sockets.length, 0);
  ws.fetchImpl = async () => endpoint();
  const handshake = ws.start({ eventDispatcher: new EventDispatcher() });
  await eventually(() => Socket.sockets.length === 1);
  const open = Socket.sockets[0].onopen;
  ws.close(); await handshake; open();
  assert.equal(ws.pingInterval, undefined); assert.equal(ws.getConnectionStatus().state, 'idle');
});

test('failed or malformed event deliveries ACK 500 or remain unacknowledged; old sockets cannot ACK on a new connection', async () => {
  const ws = new FeishuWSClient(), sent = [];
  ws.sendMessage = value => sent.push(value);
  ws.eventDispatcher = new EventDispatcher().register({ fail: () => { throw new Error('SECRET'); } });
  await ws.handleEventData(frame('event', { header: { event_type: 'fail' } }));
  assert.equal(JSON.parse(sent[0].payload).code, 500);
  await ws.handleEventData({ ...frame('event', {}), payload: Buffer.from('{') });
  assert.equal(sent.length, 1);
  ws.closed = false; const old = {}, replacement = {}; ws.socket = old;
  let release;
  ws.eventDispatcher = new EventDispatcher().register({ wait: () => new Promise(resolve => { release = resolve; }) });
  const delivery = ws.handleEventData(frame('event', { header: { event_type: 'wait' } }), old);
  ws.socket = replacement; release(); await delivery;
  assert.equal(sent.length, 1); ws.close();
});

test('frame codec rejects incomplete, truncated and invalid wire data and skips unknown fields', () => {
  const valid = encodeFrame(frame('event', {}));
  assert.throws(() => decodeFrame(valid.subarray(0, -1)));
  assert.throws(() => decodeFrame(Buffer.from([8, 128])));
  assert.throws(() => decodeFrame(Buffer.from([0])));
  assert.throws(() => decodeFrame(Buffer.alloc(0)));
  const extended = Buffer.concat([valid, Buffer.from([80, 1, 90, 2, 1, 2])]);
  assert.deepEqual(decodeFrame(extended), decodeFrame(valid));
});

test('reconnect delays back off after retryable failures and close cancels pending attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let pulls = 0;
  const ws = new FeishuWSClient({ random: () => 0, fetchImpl: async () => { pulls++; throw new Error('offline'); } });
  t.after(() => ws.close()); ws.updateConfig({ ReconnectInterval: 1 });
  await ws.start({ eventDispatcher: new EventDispatcher() });
  for (const advance of [0, 1000, 2000, 4000]) {
    t.mock.timers.tick(advance); for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  assert.equal(pulls, 5); assert.equal(ws.getReconnectInfo().nextConnectTime, Date.now() + 8000);
  ws.close(); t.mock.timers.tick(1000000); await Promise.resolve(); assert.equal(pulls, 5);
});

test('handshake deadline and optional pong watchdog reconnect, while disabled reconnect reports failure once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  Socket.sockets = []; const errors = [];
  const ws = new FeishuWSClient({ WebSocketImpl: Socket, fetchImpl: async () => endpoint(),
    autoReconnect: false, handshakeTimeoutMs: 20, onError: e => errors.push(e.message) });
  t.after(() => ws.close());
  const starting = ws.start({ eventDispatcher: new EventDispatcher() });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(20); await starting;
  assert.equal(Socket.sockets[0].readyState, 3); assert.deepEqual(errors, ['ws_reconnect_disabled']);
  ws.autoReconnect = true; ws.pingTimeoutSec = 1;
  const restarting = ws.start({ eventDispatcher: new EventDispatcher() });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  Socket.sockets[1].open(); await restarting;
  t.mock.timers.tick(1000);
  assert.equal(Socket.sockets[1].readyState, 3); assert.equal(ws.getConnectionStatus().state, 'reconnecting');
});
