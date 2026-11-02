import { encodeFrame, decodeFrame } from './feishu-frame.js';

const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const typeOf = frame => frame.headers.find(h => h.key === 'type')?.value;

// SDK DataCache semantics, with a byte/count ceiling as well as its 10s TTL.
export class FragmentCache {
  constructor({ now = Date.now, maxEntries = 128, maxBytes = 4 * 1024 * 1024, maxParts = 256 } = {}) {
    Object.assign(this, { now, maxEntries, maxBytes, maxParts }); this.cache = new Map(); this.bytes = 0;
  }
  delete(key) { const entry = this.cache.get(key); if (entry) this.bytes -= entry.bytes; this.cache.delete(key); }
  prune() { for (const [key, entry] of this.cache) if (this.now() - entry.createdAt >= 10000) this.delete(key); }
  clear() { this.cache.clear(); this.bytes = 0; }
  mergeData({ message_id: id, sum, seq, data }) {
    this.prune();
    if (!id || !Number.isInteger(sum) || sum < 1 || sum > this.maxParts || !Number.isInteger(seq) || seq < 0 || seq >= sum || !data)
      throw new Error('Invalid fragment metadata');
    let entry = this.cache.get(id);
    if (entry && entry.parts.length !== sum) { this.delete(id); throw new Error('Inconsistent fragment count'); }
    if (!entry) {
      while (this.cache.size >= this.maxEntries) this.delete(this.cache.keys().next().value);
      entry = { parts: new Array(sum), count: 0, bytes: 0, createdAt: this.now() }; this.cache.set(id, entry);
    }
    const extra = data.length - (entry.parts[seq]?.length ?? 0);
    if (this.bytes + extra > this.maxBytes) { this.delete(id); throw new Error('Fragment byte limit'); }
    if (!entry.parts[seq]) entry.count++;
    // Copy so a small fragment cannot retain an arbitrarily large input frame.
    entry.parts[seq] = Buffer.from(data); entry.bytes += extra; this.bytes += extra;
    if (entry.count !== sum) return null;
    this.delete(id);
    return JSON.parse(Buffer.concat(entry.parts, entry.bytes).toString('utf8'));
  }
}

export class EventDispatcher {
  register(handlers) { this.handlers = { ...this.handlers, ...handlers }; return this; }
  invoke(raw) {
    const type = raw.header?.event_type ?? raw.event?.type ?? raw.event_type;
    // Preserve envelopes: normalization already accepts both SDK and raw forms.
    return this.handlers?.[type]?.(raw);
  }
}

// Protocol port from node-sdk 1.76.0 WSClient. Uses Node's WebSocket instead
// of ws; no credentials, tickets, frames or event payloads go to the logger.
export class FeishuWSClient {
  constructor({ appId, appSecret, base = 'https://open.feishu.cn', fetchImpl = fetch, WebSocketImpl = WebSocket,
    logger = quiet, autoReconnect = true, onReady, onError, onReconnecting, onReconnected,
    handshakeTimeoutMs = 15000, wsConfig = {}, random = Math.random, now = Date.now } = {}) {
    Object.assign(this, { appId, appSecret, base, fetchImpl, WebSocketImpl, logger, autoReconnect,
      onReady, onError, onReconnecting, onReconnected, handshakeTimeoutMs, random, now });
    this.config = { pingInterval: 120000, reconnectCount: -1, reconnectInterval: 120000, reconnectNonce: 30000 };
    this.pingTimeoutSec = wsConfig.pingTimeout ?? 0;
    this.dataCache = new FragmentCache({ now });
    this.closed = true; this.reconnectGeneration = 0; this.currentReconnectAttempts = 0;
    this.reconnectInfo = { lastConnectTime: 0, nextConnectTime: 0 };
    // Retain the existing interception hooks used at the websocket boundary.
    this.wsConfig = { getWSInstance: () => this.socket, setWSInstance: socket => { this.socket = socket; },
      getWS: key => key === undefined ? this.config : this.config[key], updateWs: update => Object.assign(this.config, update) };
  }
  safeInvoke(label, fn, ...args) { try { fn?.(...args); } catch { this.logger.error(`ws_${label}_failed`); } }
  updateConfig(value = {}) {
    for (const [name, target, factor] of [['PingInterval', 'pingInterval', 1000], ['ReconnectCount', 'reconnectCount', 1],
      ['ReconnectInterval', 'reconnectInterval', 1000], ['ReconnectNonce', 'reconnectNonce', 1000]]) {
      const n = value[name];
      if (Number.isFinite(n) && (name === 'ReconnectCount' ? Number.isInteger(n) && n >= -1 : n >= 0))
        this.config[target] = name === 'PingInterval' ? Math.max(1, n * factor) : n * factor;
    }
  }
  async pullConnectConfig(signal) {
    try {
      const response = await this.fetchImpl(this.base + '/callback/ws/endpoint', {
        method: 'POST', headers: { 'Content-Type': 'application/json', locale: 'zh' },
        body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
      const result = await response.json();
      signal?.throwIfAborted();
      if (result.code !== 0) return { ok: false, retryable: result.code === 1000040343, error: `ws_endpoint_${result.code}` };
      if (!response.ok) return { ok: false, retryable: true };
      const url = new URL(result.data.URL);
      if (!['wss:', 'ws:'].includes(url.protocol)) return { ok: false, retryable: false, error: 'ws_invalid_endpoint' };
      this.updateConfig(result.data.ClientConfig);
      Object.assign(this.config, { connectUrl: url.href, serviceId: url.searchParams.get('service_id'), deviceId: url.searchParams.get('device_id') });
      return { ok: true };
    } catch { return { ok: false, retryable: true }; }
  }
  clearLiveness() { clearTimeout(this.livenessTimer); this.livenessTimer = undefined; }
  armLiveness() {
    this.clearLiveness();
    if (this.pingTimeoutSec > 0) this.livenessTimer = setTimeout(() => this.failSocket(this.socket), this.pingTimeoutSec * 1000);
  }
  detachSocket(socket) {
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
  }
  discardConnection() {
    clearTimeout(this.pingInterval); this.pingInterval = undefined; this.clearLiveness();
    const socket = this.socket; this.socket = null;
    this.cancelHandshake?.(); this.cancelHandshake = null;
    this.detachSocket(socket);
    try { socket?.close(); } catch { /* Native WebSocket has no terminate(). */ }
  }
  failSocket(socket) {
    if (this.closed || socket !== this.socket) return;
    this.discardConnection();
    this.reConnect();
  }
  connect(generation) {
    return new Promise(resolve => {
      let socket, timer, settled = false;
      const finish = ok => {
        if (settled) return; settled = true; clearTimeout(timer); this.cancelHandshake = null;
        resolve(ok);
      };
      try { socket = new this.WebSocketImpl(this.config.connectUrl); }
      catch { finish(false); return; }
      this.socket = socket; socket.binaryType = 'arraybuffer';
      this.cancelHandshake = () => finish(false);
      timer = setTimeout(() => { finish(false); this.discardConnection(); }, this.handshakeTimeoutMs);
      socket.onopen = () => {
        if (this.closed || generation !== this.reconnectGeneration) { finish(false); this.detachSocket(socket); socket.close(); return; }
        finish(true); this.pingLoop();
      };
      socket.onerror = () => { if (!settled) { finish(false); this.discardConnection(); } else this.failSocket(socket); };
      socket.onclose = () => { if (!settled) { finish(false); this.discardConnection(); } else this.failSocket(socket); };
      socket.onmessage = async event => {
        this.clearLiveness();
        try {
          if (event.data.byteLength > this.dataCache.maxBytes) throw new Error('Frame byte limit');
          const frame = decodeFrame(event.data);
          // Carry socket ownership across awaited durable claims; old ACKs must
          // never be sent on a replacement connection.
          if (frame.method === 0) await this.handleControlData(frame);
          if (frame.method === 1) await this.handleEventData(frame, socket);
        } catch { this.logger.error('ws_frame_failed'); }
      };
    });
  }
  async reConnect(isStart = false) {
    if (this.closed || (this.isConnecting && !isStart)) return;
    this.isConnecting = true;
    const generation = ++this.reconnectGeneration;
    this.discardConnection();
    const attempt = async () => {
      if (this.closed || generation !== this.reconnectGeneration) return;
      this.reconnectInfo.lastConnectTime = this.now();
      const result = await this.pullConnectConfig(this.abort.signal);
      if (this.closed || generation !== this.reconnectGeneration) return;
      if (result.ok) result.ok = await this.connect(generation);
      if (this.closed || generation !== this.reconnectGeneration) return;
      if (result.ok) {
        this.isConnecting = false; this.currentReconnectAttempts = 0; this.reconnectInfo.nextConnectTime = 0;
        const wasConnected = this.hasEverConnected; this.hasEverConnected = true;
        this.safeInvoke(wasConnected ? 'reconnected' : 'ready', wasConnected ? this.onReconnected : this.onReady); return;
      }
      if (result.retryable === false || !this.autoReconnect ||
        (this.currentReconnectAttempts > 0 && this.config.reconnectCount >= 0 && this.currentReconnectAttempts >= this.config.reconnectCount)) {
        this.isConnecting = false; this.terminalError = true;
        this.safeInvoke('error', this.onError, new Error(result.retryable === false ? result.error :
          !this.autoReconnect ? 'ws_reconnect_disabled' : 'ws_reconnect_exhausted')); return;
      }
      this.scheduleReconnect(attempt);
    };
    if (isStart) await attempt();
    else {
      this.safeInvoke('reconnecting', this.onReconnecting);
      this.scheduleReconnect(attempt);
    }
  }
  scheduleReconnect(attempt) {
    if (this.closed) return;
    const tries = this.currentReconnectAttempts;
    const wait = tries === 0 ? this.random() * this.config.reconnectNonce :
      this.config.reconnectInterval * Math.min(2 ** (tries - 1), 8);
    this.reconnectInfo.nextConnectTime = this.now() + wait;
    this.reconnectInterval = setTimeout(() => { this.currentReconnectAttempts++; attempt().catch(() => this.logger.error('ws_connect_failed')); }, wait);
  }
  pingLoop() {
    if (this.closed) return;
    this.sendMessage({ SeqID: 0, LogID: 0, service: Number(this.config.serviceId), method: 0, headers: [{ key: 'type', value: 'ping' }] });
    this.armLiveness();
    this.pingInterval = setTimeout(() => this.pingLoop(), this.config.pingInterval);
  }
  async handleControlData(frame) {
    // Like the SDK, server pings are ignored; the client initiates ping/pong.
    if (typeOf(frame) === 'pong' && frame.payload?.length) this.updateConfig(JSON.parse(Buffer.from(frame.payload).toString('utf8')));
  }
  async handleEventData(frame, socket) {
    const headers = Object.fromEntries(frame.headers.map(h => [h.key, h.value]));
    if (!['event', 'card'].includes(headers.type)) return;
    let raw;
    try { raw = this.dataCache.mergeData({ message_id: headers.message_id, sum: Number(headers.sum), seq: Number(headers.seq), data: frame.payload }); }
    catch { this.logger.error('ws_fragment_failed'); return; }
    if (!raw) return;
    const response = { code: 200 }, started = this.now();
    try {
      const result = await this.eventDispatcher?.invoke(raw, { needCheck: false });
      if (result) response.data = Buffer.from(JSON.stringify(result)).toString('base64');
    } catch { response.code = 500; this.logger.error('ws_event_failed'); }
    if (socket && (this.closed || socket !== this.socket)) return;
    this.sendMessage({ ...frame, headers: [...frame.headers, { key: 'biz_rt', value: String(started - this.now()) }],
      payload: Buffer.from(JSON.stringify(response)) });
  }
  sendMessage(frame) {
    const socket = this.wsConfig.getWSInstance();
    if (socket?.readyState === 1) { try { socket.send(encodeFrame(frame)); } catch { this.logger.error('ws_send_failed'); } }
  }
  getReconnectInfo() { return this.reconnectInfo; }
  getConnectionStatus() {
    return { state: this.terminalError ? 'failed' : this.isConnecting ? (this.hasEverConnected ? 'reconnecting' : 'connecting') :
      this.socket?.readyState === 1 ? 'connected' : 'idle', lastConnectTime: this.reconnectInfo.lastConnectTime || undefined,
    nextConnectTime: this.reconnectInfo.nextConnectTime || undefined, reconnectAttempts: this.currentReconnectAttempts };
  }
  async start({ eventDispatcher }) {
    this.close(); this.closed = false; this.terminalError = false; this.currentReconnectAttempts = 0;
    this.abort = new AbortController(); this.eventDispatcher = eventDispatcher;
    this.sweep = setInterval(() => this.dataCache.prune(), 10000); this.sweep.unref?.();
    await this.reConnect(true);
  }
  close() {
    this.closed = true; this.reconnectGeneration++; this.abort?.abort();
    clearTimeout(this.reconnectInterval); clearInterval(this.sweep); this.discardConnection();
    this.dataCache.clear(); this.isConnecting = false; this.currentReconnectAttempts = 0;
  }
}
