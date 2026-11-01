import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class HerdrError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

export function endpointFromEnv(env = process.env) {
  if (env.HERDR_TCP) {
    const match = /^(127\.0\.0\.1|localhost):([0-9]+)$/.exec(env.HERDR_TCP);
    if (!match || +match[2] < 1 || +match[2] > 65535) throw new Error('HERDR_TCP must be loopback host:port');
    return { host: match[1], port: +match[2] };
  }
  return { path: env.HERDR_SOCKET_PATH || join(homedir(), '.config/herdr/herdr.sock') };
}

// The server may close a request connection after its response. Never multiplex
// requests or retry writes: a dropped response does not mean input was rejected.
export class HerdrClient {
  constructor({ endpoint = endpointFromEnv(), timeoutMs = 10000, reconnectMs = 1000 } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.reconnectMs = reconnectMs;
    this.sockets = new Set();
    this.subscriptions = new Set();
    this.closed = false;
  }

  socket(onLine, onClose) {
    const socket = net.createConnection(this.endpoint);
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        socket.destroy(new HerdrError('frame_too_large')); return;
      }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); }
        catch { socket.destroy(new HerdrError('invalid_json')); return; }
        onLine(value);
      }
    });
    socket.on('error', () => {}); // request/subscription owns reporting
    socket.once('close', () => { this.sockets.delete(socket); onClose(); });
    return socket;
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new HerdrError('client_closed'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const socket = this.socket(message => {
        if (message.id !== id) return;
        if (message.error) finish(new HerdrError(message.error.code, message.error.message));
        else if ('result' in message) finish(null, message.result);
        else finish(new HerdrError('invalid_response'));
      }, () => finish(new HerdrError('connection_closed')));
      const timer = setTimeout(() => finish(new HerdrError('timeout')), this.timeoutMs);
      socket.once('error', () => finish(new HerdrError('connection_error')));
      socket.once('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    });
  }

  subscribe(subscriptions, onEvent, onState = () => {}) {
    if (this.closed) throw new HerdrError('client_closed');
    let stopped = false, socket, timer, attempt = 0, ackTimer;
    const connect = () => {
      if (stopped || this.closed) return;
      const id = randomUUID();
      socket = this.socket(message => {
        if (message.id === id) {
          clearTimeout(ackTimer);
          if (message.error) { onState('error'); socket.destroy(); }
          else { attempt = 0; onState('connected'); }
        } else if (message.event) onEvent(message);
      }, () => {
        clearTimeout(ackTimer);
        if (!stopped && !this.closed) {
          onState('disconnected');
          timer = setTimeout(connect, Math.min(this.reconnectMs * 2 ** attempt++, 30000));
          timer.unref?.();
        }
      });
      ackTimer = setTimeout(() => socket.destroy(), this.timeoutMs);
      socket.once('connect', () => socket.write(JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n'));
    };
    const stop = () => {
      stopped = true; clearTimeout(timer); clearTimeout(ackTimer); socket?.destroy();
      this.subscriptions.delete(stop);
    };
    this.subscriptions.add(stop); connect(); return stop;
  }

  close() {
    this.closed = true;
    for (const stop of this.subscriptions) stop();
    for (const socket of this.sockets) socket.destroy();
  }
}

export function paneSubscriptions(paneIds) {
  return [...new Set(paneIds)].flatMap(pane_id => [
    { type: 'pane.output_matched', pane_id, source: 'visible', lines: 40, strip_ansi: true, match: { type: 'regex', value: '(?s).*' } },
    { type: 'pane.agent_status_changed', pane_id },
  ]);
}
