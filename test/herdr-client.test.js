import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { HerdrClient, endpointFromEnv, paneSubscriptions } from '../src/herdr-client.js';
import { fakeHerdr, eventually } from './helpers.js';
import { readPane } from '../src/pane-read.js';

test('transport uses one request per connection, exact schema parameters, safe errors and reconnects subscription', async t => {
  const fake = await fakeHerdr(); const client = new HerdrClient({ endpoint: fake.endpoint, timeoutMs: 200, reconnectMs: 10 });
  t.after(async () => { client.close(); await fake.close(); });
  await client.request('workspace.create', { label: 'feishu', cwd: '/tmp', focus: false });
  assert.equal((await readPane(client, 'w1:p1', { lines: 40 })).read.text, '$ ');
  await assert.rejects(readPane(client, 'w1:p1', { source: 'recent-unwrapped' }), TypeError);
  const events = [], states = [];
  const stop = client.subscribe(paneSubscriptions(['w1:p1']), event => events.push(event), state => states.push(state));
  await eventually(() => states.includes('connected'));
  fake.output('w1:p1', 'one'); await eventually(() => events.length === 1);
  fake.disconnectSubscribers(); await eventually(() => states.filter(s => s === 'connected').length === 2);
  fake.status('w1:p1', 'blocked'); await eventually(() => events.length === 2);
  stop(); assert.equal(events[1].event, 'pane.agent_status_changed');
  client.close(); await assert.rejects(client.request('ping'), { code: 'client_closed' });
});

test('NDJSON handles split UTF-8 bytes/multiple frames, rejects malformed data, enforces timeout without replay', async t => {
  const sockets = new Set(); let count = 0;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.once('data', input => {
      count++; const { id, method } = JSON.parse(input);
      if (method === 'timeout') return;
      if (method === 'malformed') { socket.end('{bad\n'); return; }
      const response = Buffer.from(JSON.stringify({ id, result: { text: '中文🙂' } }) + '\n');
      socket.write('{"event":"ignore"}\n');
      const split = response.indexOf(Buffer.from('中')) + 1;
      socket.write(response.subarray(0, split)); setImmediate(() => socket.end(response.subarray(split)));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new HerdrClient({ endpoint: { host: '127.0.0.1', port: server.address().port }, timeoutMs: 50 });
  t.after(async () => { client.close(); for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); });
  assert.deepEqual(await client.request('unicode'), { text: '中文🙂' });
  await assert.rejects(client.request('malformed'), { code: 'connection_error' });
  await assert.rejects(client.request('timeout'), { code: 'timeout' }); assert.equal(count, 3);
});

test('endpoint defaults to local socket, env override wins and TCP is test-only loopback', () => {
  assert.equal(endpointFromEnv({ HERDR_SOCKET_PATH: '/tmp/herdr.sock' }).path, '/tmp/herdr.sock');
  assert.deepEqual(endpointFromEnv({ HERDR_TCP: '127.0.0.1:49450', HERDR_SOCKET_PATH: 'ignored' }), { host: '127.0.0.1', port: 49450 });
  assert.throws(() => endpointFromEnv({ HERDR_TCP: '0.0.0.0:49450' }));
  assert.throws(() => endpointFromEnv({ HERDR_TCP: '127.0.0.1:99999' }));
});
