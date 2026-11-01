import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { HerdrClient } from '../src/herdr-client.js';
import { Bridge } from '../src/bridge.js';

export async function fakeHerdr() {
  const calls = [], panes = new Map(), subscribers = new Map(), sockets = new Set();
  let workspace = null, sequence = 0, failNext, dropNext, holdNext;
  const emit = event => {
    for (const [socket, subscriptions] of subscribers) {
      if (subscriptions.some(s => s.pane_id === event.data.pane_id && s.type === event.event)) socket.write(JSON.stringify(event) + '\n');
    }
  };
  const create = () => {
    workspace ??= { workspace_id: 'w1', label: 'feishu' };
    const pane = { pane_id: `w1:p${++sequence}`, workspace_id: 'w1', tab_id: `w1:t${sequence}`,
      terminal_id: `term_${randomUUID()}`,
      agent: null, agent_status: 'unknown', revision: 1, text: '$ ', visible: '$ ' };
    panes.set(pane.pane_id, pane); return pane;
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8'); let buffer = '';
    socket.on('error', () => {});
    socket.on('close', () => { subscribers.delete(socket); sockets.delete(socket); });
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        calls.push(request);
        const { id, method, params: p } = request;
        if (dropNext === method) { dropNext = null; socket.destroy(); continue; }
        if (failNext?.method === method) { socket.end(JSON.stringify({ id, error: { code: failNext.code, message: 'fixture error with secret detail' } }) + '\n'); failNext = null; continue; }
        let result, error;
        const pane = panes.get(p.pane_id ?? p.target);
        switch (method) {
          case 'ping': result = { type: 'pong', version: '0.9.5', protocol: 22 }; break;
          case 'workspace.list': result = { type: 'workspace_list', workspaces: workspace ? [workspace] : [] }; break;
          case 'workspace.create': workspace = { workspace_id: 'w1', label: p.label }; result = { type: 'workspace_created', workspace, root_pane: create() }; break;
          case 'tab.create': result = { type: 'tab_created', root_pane: create() }; break;
          case 'pane.list': result = { type: 'pane_list', panes: [...panes.values()] }; break;
          case 'pane.get': if (pane) result = { type: 'pane_info', pane }; else error = 'pane_not_found'; break;
          case 'agent.list': result = { type: 'agent_list', agents: [...panes.values()].filter(pane => pane.agent) }; break;
          case 'agent.prompt':
            if (pane?.agent_status === 'blocked') error = 'agent_blocked';
            else if (!pane?.agent) error = 'agent_not_found';
            else result = { type: 'ok' };
            break;
          case 'pane.read':
            if (!['visible', 'recent_unwrapped'].includes(p.source)) { error = 'invalid_source'; break; }
            if (!pane) { error = 'pane_not_found'; break; }
            result = { type: 'pane_read', read: { pane_id: pane.pane_id, text: p.source === 'visible' ? pane.visible : pane.text, revision: pane.revision, source: p.source, truncated: false } };
            break;
          case 'pane.send_text': case 'pane.send_keys': if (!pane) error = 'pane_not_found'; else result = { type: 'ok' }; break;
          case 'pane.close': panes.delete(p.pane_id); result = { type: 'ok' }; break;
          case 'events.subscribe': subscribers.set(socket, p.subscriptions); result = { type: 'subscription_started' }; break;
          default: error = 'unknown_method';
        }
        // One response per request connection, just like the live herdr server.
        const response = JSON.stringify(error ? { id, error: { code: error, message: error } } : { id, result }) + '\n';
        if (holdNext?.method === method) {
          const hold = holdNext; holdNext = null;
          Promise.resolve(hold.wait()).then(() => socket.end(response));
        } else if (method === 'events.subscribe') socket.write(response);
        else socket.end(response);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, panes, subscribers, create, emit, workspace: () => workspace, endpoint: { host: '127.0.0.1', port: server.address().port },
    fail(method, code) { failNext = { method, code }; }, drop(method) { dropNext = method; },
    hold(method, wait) { holdNext = { method, wait }; },
    output(paneId, text) {
      const pane = panes.get(paneId); Object.assign(pane, { text, visible: text, revision: pane.revision + 1 });
      emit({ event: 'pane.output_matched', data: { pane_id: paneId, read: { text, revision: pane.revision } } });
    },
    status(paneId, agent_status, agent = 'codex') {
      Object.assign(panes.get(paneId), { agent, agent_status });
      emit({ event: 'pane.agent_status_changed', data: { pane_id: paneId, agent_status, agent } });
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
    disconnectSubscribers() { for (const socket of subscribers.keys()) socket.destroy(); },
  };
}

export async function eventually(check, label = 'condition') {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out: ${label}`);
}

export function mockFeishu(now) {
  const calls = []; let sequence = 0;
  return { calls,
    async start(onEvent) { this.deliver = onEvent; }, close() {},
    async send(chatId, text, uuid) { const id = `bot-${++sequence}`; calls.push({ type: 'send', id, chatId, text, uuid, time: now() }); return id; },
    async reply(topicId, content, msgType = 'text', uuid) { const id = `bot-${++sequence}`; calls.push({ type: 'reply', id, topicId, content, msgType, uuid, time: now() }); return id; },
    async patch(id, card) { calls.push({ type: 'patch', id, card, time: now() }); },
  };
}

export function message(text, id = 'm1', topicId = id, override = {}) {
  return { kind: 'message', messageId: id, eventId: `e-${id}`, chatId: 'oc_test', chatType: 'topic_group',
    senderType: 'user', openId: 'ou_test', topicId, isReply: topicId !== id, text, ...override };
}

export async function harness(t) {
  const temp = await mkdtemp(new URL('../.test-', import.meta.url));
  const fake = await fakeHerdr();
  let time = 0;
  const now = () => time;
  const store = await new Store(join(temp, 'state.json')).load();
  const feishu = mockFeishu(now), audits = [], errors = [];
  const config = { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: '/tmp', stateFile: store.file, auditFile: join(temp, 'audit.jsonl') };
  const makeBridge = state => new Bridge({ herdr: new HerdrClient({ endpoint: fake.endpoint, timeoutMs: 300, reconnectMs: 10 }), feishu,
    store: state, config, now, audit: async record => audits.push(record), onError: code => errors.push(code) });
  let bridge = makeBridge(store); await bridge.start({ timers: false });
  t.after(async () => { await bridge.stop(); await fake.close(); await rm(temp, { recursive: true, force: true }); });
  return { fake, store, feishu, audits, errors, now, config,
    get bridge() { return bridge; },
    advance(ms) { time += ms; },
    async restart() { await bridge.stop(); const restored = await new Store(store.file).load(); bridge = makeBridge(restored); await bridge.start({ timers: false }); return restored; },
    async subscribed() { await eventually(() => fake.subscribers.size > 0, 'subscribed'); },
    async drain() { await new Promise(resolve => setTimeout(resolve, 10)); await bridge.queue; },
  };
}
