import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HerdrClient, HerdrError } from '../herdr-client.js';
import { detectMenu } from '../menus.js';
import { screenActivity } from '../transcripts/background.js';

const required = ['terminal.list', 'terminal.get', 'terminal.read', 'terminal.send', 'terminal.keys', 'terminal.run', 'terminal.kill', 'events.subscribe', 'server.status'];
const rpcError = e => new HerdrError(e.data?.kind ?? 'hc_error');
const checkHello = h => {
  if (h?.generation !== 1 || !h.core?.id || !required.every(m => h.methods?.includes(m)) || !h.features?.includes('events'))
    throw new HerdrError('hc_incompatible');
  return h;
};
export function hcEndpoint(env = process.env) {
  return { path: env.HC_TERMINAL_SOCKET || env.HC_SOCKET_PATH ||
    join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'herdr-core', 'default.sock') };
}

// Plain JSON-RPC over the local socket: no helper process, attach viewer or
// terminal resize for normal reads/writes. Each request negotiates generation 1.
export class HcClient extends HerdrClient {
  constructor(options = {}) { super({ endpoint: hcEndpoint(), ...options }); this.writeTimeoutMs = options.writeTimeoutMs ?? 60000; }
  request(method, params = {}, onHello = () => {}) {
    if (this.closed) return Promise.reject(new HerdrError('client_closed'));
    return new Promise((resolve, reject) => {
      const id = randomUUID(), helloId = randomUUID();
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const send = (id, method, params) => socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const socket = this.socket(message => {
        if (![id, helloId].includes(message.id)) return;
        if (message.error) { finish(rpcError(message.error)); return; }
        if (message.id === helloId) {
          try { onHello(checkHello(message.result)); send(id, method, params); } catch (error) { finish(error); }
        } else if ('result' in message) finish(null, message.result);
        else finish(new HerdrError('invalid_response'));
      }, () => finish(new HerdrError('connection_closed')));
      const timer = setTimeout(() => finish(new HerdrError('timeout')),
        ['terminal.send', 'terminal.keys', 'terminal.run', 'terminal.kill'].includes(method) ? this.writeTimeoutMs : this.timeoutMs);
      socket.once('error', () => finish(new HerdrError('connection_error')));
      socket.once('connect', () => send(helloId, 'hello', { generation: 1, framed: false }));
    });
  }
  subscribe(_ids, onEvent, onState = () => {}) {
    let stopped = false, socket, retry, ackTimer;
    const connect = () => {
      if (stopped || this.closed) return;
      let hello = false;
      const send = (id, method, params) => socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      socket = this.socket(m => {
        if (m.error) { socket.destroy(); return; }
        if (m.id === 'hello') {
          try { checkHello(m.result); hello = true; send('subscribe', 'events.subscribe', {}); }
          catch { socket.destroy(); }
        } else if (m.id === 'subscribe') {
          clearTimeout(ackTimer); onState('connected');
          for (const t of m.result.terminals ?? []) onEvent({ data: { pane_id: `hc:${t.address}` } });
        } else if (hello && m.method === 'event') onEvent({ data: { pane_id: `hc:${m.params.terminal}` } });
        else if (hello && m.method === 'missed') for (const t of m.params.terminals ?? []) onEvent({ data: { pane_id: `hc:${t.address}` } });
      }, () => {
        clearTimeout(ackTimer);
        if (!stopped && !this.closed) {
          onState('disconnected'); retry = setTimeout(connect, this.reconnectMs); retry.unref?.();
        }
      });
      ackTimer = setTimeout(() => socket.destroy(), this.timeoutMs);
      socket.once('connect', () => send('hello', 'hello', { generation: 1, framed: false }));
    };
    const stop = () => { stopped = true; clearTimeout(retry); clearTimeout(ackTimer); socket?.destroy(); this.subscriptions.delete(stop); };
    this.subscriptions.add(stop); connect(); return stop;
  }
  // terminal.send always submits. /t raw needs the documented framed DATA
  // stream instead. Attach at the current size, never send RESIZE/FOCUS, and
  // confirm parsing with a following server.status reply on the same stream;
  // uncertain delivery remains needs_check. Stream input has no CREDIT ack.
  raw(terminal, text, size) {
    if (this.closed) return Promise.reject(new HerdrError('client_closed'));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.endpoint); this.sockets.add(socket);
      let buffer = Buffer.alloc(0), framed = false, channel, finished = false;
      const frame = (ch, kind, data) => { const h = Buffer.alloc(9); h.writeUInt32LE(ch); h[4] = kind; h.writeUInt32LE(data.length, 5); return Buffer.concat([h, data]); };
      const finish = error => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); this.sockets.delete(socket); error ? reject(error) : resolve({}); };
      const timer = setTimeout(() => finish(new HerdrError('timeout')), this.writeTimeoutMs);
      socket.on('error', () => finish(new HerdrError('connection_error')));
      socket.on('close', () => finish(new HerdrError('connection_closed')));
      socket.once('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 'hello', method: 'hello', params: { generation: 1, framed: true } }) + '\n'));
      socket.on('data', chunk => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > 16 * 1024 * 1024) throw new HerdrError('frame_too_large');
          if (!framed) {
            const end = buffer.indexOf(10); if (end < 0) return;
            const m = JSON.parse(buffer.subarray(0, end)); buffer = buffer.subarray(end + 1);
            checkHello(m.result);
            if (!m.result.framed || !m.result.features.includes('attach')) throw new HerdrError('hc_incompatible');
            framed = true;
            socket.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'attach', method: 'terminal.attach',
              params: { terminal, cols: size.cols, rows: size.rows, history: 0, resumed: true } }))));
          }
          while (buffer.length >= 9) {
            const ch = buffer.readUInt32LE(0), kind = buffer[4], len = buffer.readUInt32LE(5);
            if (len > 16 * 1024 * 1024) throw new HerdrError('frame_too_large');
            if (buffer.length < len + 9) return;
            const data = buffer.subarray(9, 9 + len); buffer = buffer.subarray(9 + len);
            if (ch === 0 && kind === 0) {
              const m = JSON.parse(data); if (m.error) throw rpcError(m.error);
              if (m.id === 'attach') {
                channel = m.result.channel;
                // Bracketed paste preserves multiline raw input without Enter.
                const bytes = Buffer.from(`\x1b[200~${text}\x1b[201~`);
                if (bytes.length > 256 * 1024) throw new HerdrError('input_too_large');
                socket.write(frame(channel, 0, bytes));
                socket.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'barrier', method: 'server.status', params: {} }))));
              } else if (m.id === 'barrier') {
                socket.write(frame(channel, 2, Buffer.alloc(0))); finish(); return;
              }
            }
          }
        } catch (error) { finish(error); }
      });
    });
  }
}

export class HcBackend {
  constructor(client = new HcClient()) { this.name = 'hc'; this.client = client; }
  address(id) {
    if (!/^hc:(?:[a-zA-Z0-9_.-]+\/)?t[a-zA-Z0-9]+$/.test(id)) throw new HerdrError('invalid_terminal');
    return id.slice(3);
  }
  normalize(t, hello) {
    return { ...t, pane_id: `hc:${t.address}`, terminal_id: `hc:${hello.core.id}:${t.address}:${t.created_ms}:${t.pid}`,
      backendLabel: 'herdr-core', foreground_pid: t.foreground?.pid ?? t.pid,
      foreground_cwd: t.foreground?.cwd, terminal_title_stripped: t.title,
      agent: /^(claude|codex)$/i.test(t.foreground?.name ?? '') ? t.foreground.name.toLowerCase() : null,
      agent_status: this.status(t) };
  }
  async call(method, params) { let hello; const result = await this.client.request(method, params, h => { hello = h; }); return { result, hello }; }
  async list() {
    const { result, hello } = await this.call('terminal.list', {});
    return result.terminals.filter(t => t.state === 'live').map(t => this.normalize(t, hello));
  }
  async get(id) {
    const { result, hello } = await this.call('terminal.get', { terminal: this.address(id) });
    if (result.state !== 'live' || `hc:${result.address}` !== id) throw new HerdrError('terminal_finished');
    return this.normalize(result, hello);
  }
  async read(id, _options) {
    // api.rs terminal_read: stitching/scrolling only runs when lines > 0.
    // lines:0 slices the core's own screen, with no attach or resize call.
    const { result } = await this.call('terminal.read', { terminal: this.address(id), lines: 0 });
    return { read: result };
  }
  async sendText(id, text, { submit = false } = {}) {
    if (!submit) { const t = await this.get(id); return this.client.raw(this.address(id), text, t); }
    const { result } = await this.call('terminal.send', { terminal: this.address(id), text, wait: false });
    // started:false/null describes observed agent status, NOT failed delivery.
    if (!Number.isSafeInteger(result.turn)) throw new HerdrError('invalid_response');
    return result;
  }
  async sendKeys(id, keys) {
    const { result } = await this.call('terminal.keys', { terminal: this.address(id), keys });
    if (!Number.isSafeInteger(result.turn)) throw new HerdrError('invalid_response');
    return result;
  }
  close(id) { return this.client.request('terminal.kill', { terminal: this.address(id) }); }
  async create(cmd, cwd) {
    const { result } = await this.call('terminal.run', { ...(cmd ? { line: cmd } : {}), cwd, no_parent: true, wait: false, labels: { source: 'feishu-terminal' } });
    const terminal = await this.get(`hc:${result.address}`);
    return terminal;
  }
  subscribe(ids, onEvent, onState) { return this.client.subscribe(ids, event => { if (ids.includes(event.data.pane_id)) onEvent(event); }, onState); }
  identity(t) { return { terminalId: t.terminal_id }; }
  processOf(t) { return t.foreground?.pid ?? t.pid ?? null; }
  status(t, screen = '') {
    if (t.reported) return ({ done: 'idle', error: 'blocked' })[t.status?.state] ??
      (['working', 'blocked', 'idle'].includes(t.status?.state) ? t.status.state : 'unknown');
    if (detectMenu(screen).kind) return 'blocked';
    if (screenActivity(screen).spinner) return 'working';
    return /(?:[❯›]\s*$|\?\s+for shortcuts)/mu.test(screen) ? 'idle' : 'unknown';
  }
  dispose() { this.client.close(); }
}
