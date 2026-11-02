import net from 'node:net';
import assert from 'node:assert/strict';

// Shapes transcribed from commander-provided `hc schema`, core 0.1.16,
// JSON-RPC generation 1. Keep the real terminal/status objects, not pane RPCs.
export async function fakeHc() {
  const calls = [], terminals = new Map(), sockets = new Set(), subscribers = new Set(), raw = [];
  let sequence = 0, dropped, failed, delay = 0, started = null, coreId = 'core-fixture';
  const methods = ['hello', 'terminal.list', 'terminal.get', 'terminal.read', 'terminal.send', 'terminal.keys', 'terminal.run', 'terminal.kill', 'terminal.attach', 'events.subscribe', 'server.status'];
  const create = (props = {}) => {
    const address = `t${++sequence}`;
    const t = { address, argv: ['/bin/sh'], cwd: '/tmp', state: 'live', created_ms: sequence,
      pid: sequence + 1000, foreground: { pid: sequence + 1000, name: 'sh', argv: ['/bin/sh'], cwd: '/tmp' },
      labels: {}, screen: 'exact', cols: 200, rows: 120, reported: false, status: null, turn: 0, title: '', ...props };
    terminals.set(t.address, t); return t;
  };
  const frame = (channel, kind, payload) => {
    const h = Buffer.alloc(9); h.writeUInt32LE(channel); h[4] = kind; h.writeUInt32LE(payload.length, 5);
    return Buffer.concat([h, payload]);
  };
  const server = net.createServer(socket => {
    sockets.add(socket); let buffer = Buffer.alloc(0), framed = false, negotiated = false;
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); subscribers.delete(socket); });
    const dispatch = request => {
      calls.push(request);
      const { id, method, params: p } = request;
      assert.equal(request.jsonrpc, '2.0');
      assert.ok(methods.includes(method), method);
      if (method !== 'hello') assert.ok(negotiated, 'hello on every connection');
      if (dropped === method) { dropped = null; socket.destroy(); return; }
      const respond = (result, error) => {
        const m = { jsonrpc: '2.0', id, ...(error ? { error: { code: -32000, message: 'upstream detail', data: { kind: error } } } : { result }) };
        socket.write(framed ? frame(0, 0, Buffer.from(JSON.stringify(m))) : JSON.stringify(m) + '\n');
      };
      if (failed?.method === method) { respond(null, failed.code); failed = null; return; }
      const t = terminals.get(p.terminal);
      if (method.startsWith('terminal.') && method !== 'terminal.list' && method !== 'terminal.run' && !t) { respond(null, 'not_found'); return; }
      switch (method) {
        case 'hello':
          assert.equal(p.generation, 1); negotiated = true;
          respond({ generation: 1, version: '0.1.16', core: { id: coreId, name: 'test' }, framed: p.framed, methods, features: ['events', 'attach', 'framed', 'status'] });
          framed = Boolean(p.framed); break;
        case 'terminal.list': respond({ terminals: [...terminals.values()], hidden_finished: 0, machines: [] }); break;
        case 'terminal.get': respond(t); break;
        case 'terminal.run': { const created = create({ cwd: p.cwd, labels: p.labels, ...(p.line ? { argv: ['sh', '-c', p.line] } : {}) }); respond(created); break; }
        case 'terminal.read':
          assert.deepEqual(Object.keys(p).sort(), ['lines', 'terminal']);
          assert.equal(p.lines, 0, 'never request stitching/history');
          respond({ text: t.output ?? '$ ', complete: true, how: 'screen', why: null }); break;
        case 'terminal.send':
          if (t.reported && t.status?.state === 'blocked') { respond(null, 'blocked'); break; }
          assert.equal(p.wait, false); setTimeout(() => respond({ turn: t.turn, started, status: t.status?.state ?? null }), delay); break;
        case 'terminal.keys': setTimeout(() => respond({ turn: t.turn, status: t.status?.state ?? null }), delay); break;
        case 'terminal.kill': t.state = 'finished'; respond(t); break;
        case 'terminal.attach':
          assert.ok(framed); assert.equal(p.cols, t.cols); assert.equal(p.rows, t.rows); assert.equal(p.history, 0);
          respond({ channel: 1, terminal: t }); break;
        case 'events.subscribe':
          assert.deepEqual(p, {}); subscribers.add(socket); respond({ seq: 1, terminals: [...terminals.values()] }); break;
        case 'server.status': respond({}); break;
      }
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (framed) {
          if (buffer.length < 9) return;
          const channel = buffer.readUInt32LE(0), kind = buffer[4], length = buffer.readUInt32LE(5);
          if (buffer.length < 9 + length) return;
          const data = buffer.subarray(9, 9 + length); buffer = buffer.subarray(9 + length);
          if (channel === 0) dispatch(JSON.parse(data));
          else if (kind === 0) raw.push(data.toString());
          else assert.equal(kind, 2, 'no resize or focus');
        } else {
          const end = buffer.indexOf(10); if (end < 0) return;
          const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1); dispatch(JSON.parse(line));
        }
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { calls, terminals, create, raw, subscribers, endpoint: { host: '127.0.0.1', port: server.address().port },
    emit(address) { for (const s of subscribers) s.write(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { seq: 2, type: 'title', terminal: address, data: {} } }) + '\n'); },
    drop(method) { dropped = method; }, fail(method, code) { failed = { method, code }; },
    delay(ms) { delay = ms; }, started(value) { started = value; }, coreId(value) { coreId = value; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r)); },
  };
}
