import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from './bridge.js';
import { Store } from './store.js';
import { HerdrClient, endpointFromEnv, endpointLabel } from './herdr-client.js';
import { Feishu, messageEvent, actionEvent } from './feishu.js';
import { runtimePaths } from './runtime.js';

function check(condition) { if (!condition) throw new Error('selftest_assertion'); }
async function until(test, { timeoutMs, sleep, now, signal }) {
  const deadline = now() + timeoutMs;
  do { signal?.throwIfAborted(); if (await test()) return; await sleep(300); } while (now() < deadline);
  throw new Error('selftest_timeout');
}

// Explicit invocation only. Inbound delivery is deliberately not exercised.
export async function selftest({ config, socket, env = process.env, stateDir = runtimePaths(env).stateDir,
  feishu = new Feishu({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET }),
  herdr = new HerdrClient({ endpoint: socket ? { path: socket } : endpointFromEnv(env) }),
  print = line => console.log(line), sleep = delay, now = Date.now, timeoutMs = 20000, signal } = {}) {
  if (!socket && !env.HERDR_TCP) {
    print('FAIL herdr endpoint: pass --herdr-socket or explicit HERDR_TCP');
    feishu.close(); herdr.close(); return 1;
  }
  print(`SELFTEST herdr ${endpointLabel(herdr.endpoint ?? (socket ? { path: socket } : endpointFromEnv(env)))}; may differ from the service's endpoint.`);
  const owned = new Set(), replies = new Set(), sent = new Set();
  let bridge, temp, failed = false, activeStep = 'initialize', patches = 0, patchIds = [];
  const runStep = async (name, fn) => { activeStep = name; signal?.throwIfAborted(); await fn(); print(`PASS ${name}`); };
  const waitFor = test => until(test, { timeoutMs, sleep, now, signal });
  const labelCard = card => ({ ...card, header: { ...card.header,
    title: { ...card.header.title, content: '[selftest] ' + card.header.title.content } } });
  const edge = {
    async send(chat, text, uuid) {
      const id = await feishu.send(chat, '[selftest] ' + text, uuid);
      sent.add(id); return id;
    },
    async reply(topic, content, type = 'text', uuid) {
      const id = await feishu.reply(topic, type === 'text' ? '[selftest] ' + content : labelCard(content), type, uuid);
      sent.add(id); replies.add(id); return id;
    },
    async patch(id, card) { await feishu.patch(id, labelCard(card)); patches++; patchIds.push(id); },
    close() { feishu.close(); },
  };
  const terminal = {
    async request(method, params) {
      const result = await herdr.request(method, params);
      if (['workspace.create', 'tab.create'].includes(method) && result.root_pane?.pane_id) owned.add(result.root_pane.pane_id);
      return result;
    },
    subscribe: (...args) => herdr.subscribe(...args), close() { herdr.close(); },
  };
  try {
    await runStep('herdr reachable', () => herdr.request('ping'));
    await runStep('WS connected (SDK state)', async () => {
      // Passive dispatcher: do not execute real user events or compete with the service Bridge.
      const start = feishu.start(() => {});
      let error = false; start.catch(() => { error = true; });
      try {
        await waitFor(() => {
          if (error || feishu.ws.getConnectionStatus().state === 'failed') throw new Error('ws_failed');
          return feishu.ws.getConnectionStatus().state === 'connected';
        });
      } finally { feishu.close(); }
    });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    temp = await mkdtemp(join(stateDir, 'selftest-'));
    const testConfig = { ...config, stateFile: join(temp, 'bridge.json'), auditFile: join(temp, 'audit.jsonl') };
    const store = await new Store(testConfig.stateFile).load();
    bridge = new Bridge({ herdr: terminal, feishu: edge, store, config: testConfig, now });
    const suffix = randomUUID().replaceAll('-', '');
    const marker = `selftest-${suffix}`, patchMarker = `selftest-patch-${suffix}`;
    let root, paneId, threadId;
    const deliver = (text, messageId, reply = true) => bridge.handle(messageEvent({ schema: '2.0',
      header: { event_id: randomUUID(), event_type: 'im.message.receive_v1' },
      event: { sender: { sender_id: { open_id: config.operatorOpenIds[0] }, sender_type: 'user' },
        message: { message_id: messageId, chat_id: config.chatIds[0], chat_type: 'group',
          message_type: 'text', content: JSON.stringify({ text }), ...(reply ? { root_id: root, parent_id: root } : {}) } } }));
    const input = async text => {
      const id = await feishu.reply(root, `[selftest] synthetic inbound: ${text}`);
      await deliver(text, id);
    };
    const readSent = async () => {
      const messages = [];
      for (const id of sent) {
        const message = await feishu.getMessage(id);
        check(message?.message_id === id);
        messages.push(message);
      }
      return messages;
    };
    let historyDenied = false;
    const readback = async text => {
      await bridge.tick();
      // Per-id reads verify our own replies/cards without depending on group history.
      const messages = await readSent();
      if (!historyDenied) {
        try { messages.push(...await feishu.threadMessages(threadId)); }
        catch (error) {
          if (!['230027', '99991672', '99991676'].includes(String(error.code))) throw error;
          historyDenied = true;
          print('NOTE history list needs im:message.group_msg (pending) — verified by message id instead');
        }
      }
      // Only Bridge-generated text replies count, never the echo command or synthetic input label.
      return messages.some(m => replies.has(m.message_id) && m.msg_type === 'text' &&
        JSON.parse(m.body?.content || '{}').text?.split(/\r?\n/).some(line => line.replace(/^\[selftest\] /, '').trim() === text));
    };
    await runStep('top-level post -> topic and pane', async () => {
      const command = ": '[selftest]'; echo selftest-ready";
      root = await feishu.send(config.chatIds[0], command);
      await deliver(command, root, false);
      const binding = store.binding(config.chatIds[0], root);
      check(binding && owned.has(binding.paneId)); paneId = binding.paneId;
      const message = await feishu.getMessage(root); threadId = message.thread_id;
      check(threadId);
      check((await herdr.request('pane.get', { pane_id: paneId })).pane?.pane_id === paneId);
    });
    await runStep('echo -> topic output read back', async () => {
      await input(`: '[selftest]'; echo ${marker}`);
      await waitFor(async () => {
        const { read } = await herdr.request('pane.read', { pane_id: paneId, source: 'recent_unwrapped', lines: 80 });
        return read.text.split(/\r?\n/).some(line => line.trim() === marker);
      });
      await waitFor(() => readback(marker));
    });
    await runStep('card patch and changed screen read back', async () => {
      const before = patches;
      await input(`: '[selftest]'; echo ${patchMarker}`);
      await waitFor(async () => {
        await bridge.tick();
        const binding = store.binding(config.chatIds[0], root);
        if (patches <= before || !patchIds.includes(binding.cardId)) return false;
        const card = await feishu.getMessage(binding.cardId);
        return card.msg_type === 'interactive' && JSON.stringify(card.body).includes(patchMarker);
      });
    });
    await runStep('/t screen', async () => {
      const before = patches; await input('/t screen');
      await waitFor(async () => { await bridge.tick(); return patches > before; });
    });
    await runStep('synthetic card Refresh callback', async () => {
      const binding = store.binding(config.chatIds[0], root), before = patches;
      await bridge.handle(actionEvent({ schema: '2.0', header: { event_id: randomUUID(), event_type: 'card.action.trigger' },
        event: { operator: { open_id: config.operatorOpenIds[0] }, token: randomUUID(),
          context: { open_chat_id: config.chatIds[0], open_message_id: binding.cardId },
          action: { tag: 'button', value: { topic_id: root, nonce: binding.nonce, key: 'refresh' } } } }));
      check(store.binding(config.chatIds[0], root).nonce !== binding.nonce);
      await waitFor(async () => { await bridge.tick(); return patches > before; });
    });
    await runStep('/t k ctrl+c (interrupt verified)', async () => {
      await input(": '[selftest]'; sleep 30; echo selftest-interrupt-failed");
      await sleep(500); await input('/t k ctrl+c');
      const interrupted = `selftest-interrupted-${suffix}`;
      await input(`: '[selftest]'; echo ${interrupted}`);
      // A missed Ctrl-C leaves this echo behind sleep, beyond this shorter deadline.
      await until(() => readback(interrupted), { timeoutMs: Math.min(timeoutMs, 10000), sleep, now, signal });
    });
    await runStep('/t close (unbind)', async () => {
      await input('/t close'); check(!store.binding(config.chatIds[0], root));
      check((await herdr.request('pane.get', { pane_id: paneId })).pane?.pane_id === paneId);
    });
    await runStep('/t close --kill (owned pane closed)', async () => {
      // Rebind only the pane this run created; preserve /t close semantics.
      await store.bind({ chatId: config.chatIds[0], topicId: root, paneId, identity: await bridge.identity(paneId) });
      await input('/t close --kill'); check(!store.binding(config.chatIds[0], root));
      const { panes } = await herdr.request('pane.list'); check(!panes.some(p => p.pane_id === paneId));
      owned.delete(paneId);
      await readSent();
    });
  } catch {
    print(`FAIL ${activeStep}`); failed = true;
  } finally {
    // Stop subscriptions/queue before cleanup, keeping the request client open.
    if (bridge) {
      bridge.stopped = true; bridge.unsubscribe?.(); await bridge.queue;
    }
    for (const pane_id of owned) {
      try {
        await herdr.request('pane.close', { pane_id });
        const { panes } = await herdr.request('pane.list'); check(!panes.some(p => p.pane_id === pane_id));
      } catch { print(`FAIL cleanup owned pane ${pane_id}`); failed = true; }
    }
    feishu.close(); herdr.close();
    if (temp) await rm(temp, { recursive: true, force: true });
  }
  print('NOTE inbound event delivery and real user button delivery require a manual Feishu check.');
  return failed ? 1 : 0;
}
