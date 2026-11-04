import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend, HcClient } from '../src/backends/hc.js';
import { coreHarness } from './ft25-helper.js';
import { message } from './helpers.js';

const title = call => (call.card ?? call.content ?? call.text)?.header?.title.content;
const mutations = h => h.hc.calls.filter(c => ['terminal.run', 'terminal.send', 'terminal.keys', 'terminal.kill', 'terminal.rm'].includes(c.method));
const callbacks = value => !value || typeof value !== 'object' ? [] :
  [...(value.type === 'callback' ? [value.value] : []), ...Object.values(value).flatMap(callbacks)];

async function setup(t, { links = true } = {}) {
  const base = await coreHarness(t, { sessionFollow: 'warn' });
  let bridge = base.bridge, sequence = 0;
  bridge.adapters = {};
  const create = props => {
    sequence++;
    return base.hc.create({ created_ms: base.now(), cwd: base.config.defaultCwd, name: 'w6-child', title: 'Child session',
      labels: { session: `child-${sequence}-fixture` }, reported: true, status: { app: 'pi', state: 'done' },
      foreground: { name: 'pi', argv: ['pi'], cwd: base.config.defaultCwd, pid: 1200 + sequence }, ...props });
  };
  if (links) base.feishu.getMessage = async id => ({ message_id: id,
    chat_id: bridge.store.list().find(b => b.topicId === id)?.chatId, thread_id: `omt_fixture_${id}`, thread_message_position: 0 });
  const parent = create({ name: 'w6-parent', title: 'Parent session', labels: { session: 'parent-fixture' } });
  await bridge.handle(message(`/t open hc:${parent.address}`, 'open-parent')); await bridge.tick();
  t.after(() => bridge.stop());
  return { ...base, parent, create, get bridge() { return bridge; },
    child: (props = {}) => create({ parent: parent.address, ...props }),
    bound: terminal => bridge.store.forPane(`hc:${(terminal ?? parent).address}`),
    async poll(ms = 2000) { base.advance(ms); await bridge.tick(); },
    async restart() {
      await bridge.stop();
      const store = await new Store(base.store.file).load();
      const backend = new Backends([new HcBackend(new HcClient({ endpoint: base.hc.endpoint, timeoutMs: 300 }))]);
      bridge = new Bridge({ backend, store, feishu: base.feishu, config: base.config, now: base.now,
        adapters: {}, sessionFollow: base.follow, audit: async () => {}, onError: error => base.errors.push(error) });
      await bridge.start({ timers: false });
    },
  };
}

test('a child gets a same-group topic, own session identity, parent return link and one parent-card row', async t => {
  const h = await setup(t), child = h.child(); await h.poll();
  const binding = h.bound(child), parent = h.bound();
  assert.ok(binding); assert.equal(binding.chatId, parent.chatId); assert.equal(binding.tree.parentTopicId, parent.topicId);
  const root = h.feishu.calls.find(c => c.type === 'send' && c.id === binding.topicId);
  assert.equal(title(root), '└ w6-child · Parent session');
  assert.match(root.text.body.elements[0].content, /会话：Child session · child-2-/);
  assert.match(JSON.stringify(root.text), /└ w6-child · 父：Parent session.*返回/);
  const panel = h.feishu.calls.find(c => c.id === parent.childrenCard.cardId);
  assert.equal(title(panel), '子终端 (1)');
  assert.match(JSON.stringify(panel.content), /w6-child.*Child session.*child-2-.*已空闲.*刚刚.*打开/);
  const link = new URL(parent.childrenCard.rows[0].url);
  assert.equal(link.searchParams.get('open_thread_id'), `omt_fixture_${binding.topicId}`);
  assert.equal(link.searchParams.get('open_chat_id'), parent.chatId);
  assert.equal(mutations(h).length, 0);
});

test('nested children discovered in reverse order name the immediate parent and appear only in its card', async t => {
  const h = await setup(t);
  const grandchild = h.create({ address: 't3', parent: 't2', name: 'w6-grandchild', title: 'Grandchild session' });
  const child = h.child({ address: 't2' }); await h.poll();
  const grand = h.bound(grandchild), direct = h.bound(child);
  assert.equal(grand.tree.parentTopicId, direct.topicId);
  assert.equal(title(h.feishu.calls.find(c => c.id === grand.topicId)), '└ w6-grandchild · Child session');
  assert.deepEqual(h.bound().childrenCard.rows.map(row => row.topicId), [direct.topicId]);
  assert.deepEqual(direct.childrenCard.rows.map(row => row.topicId), [grand.topicId]);
  assert.equal(h.bridge.store.list().length, 3);
});

test('unbound, frozen and unregistered parents do not create child topics', async t => {
  for (const mode of ['unbound', 'frozen', 'unregistered']) {
    const h = await setup(t), child = h.child({ parent: mode === 'unbound' ? 't404' : h.parent.address });
    if (mode === 'frozen') await h.bridge.store.update(h.bound().chatId, h.bound().topicId, { frozen: true, identity: { terminalId: 'different-terminal' } });
    if (mode === 'unregistered') h.bridge.registry = { get: () => null, list: () => [] };
    await h.poll();
    assert.equal(h.bound(child), undefined);
    assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 1);
  }
});

test('status changes debounce into patches of one parent card and never rotate the parent input nonce', async t => {
  const h = await setup(t), controlNonce = h.bound().nonce, child = h.child(); await h.poll();
  const id = h.bound().childrenCard.cardId;
  child.status.state = 'working'; await h.poll(1000);
  child.status.state = 'blocked'; await h.poll(1000);
  assert.equal(h.feishu.calls.filter(c => c.type === 'patch' && c.id === id).length, 0);
  await h.poll(1000);
  const patches = h.feishu.calls.filter(c => c.type === 'patch' && c.id === id);
  assert.equal(patches.length, 1); assert.match(JSON.stringify(patches[0].card), /待审批/);
  assert.equal(patches[0].card.header.template, 'orange');
  child.status.state = 'done'; await h.poll(1000); await h.poll(1000);
  assert.equal(h.bound().childrenCard.cardId, id);
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && title(c)?.startsWith('子终端')).length, 1);
  assert.equal(h.bound().nonce, controlNonce);
});

test('child finish posts one closing card and marks its parent row finished, including across restart', async t => {
  const h = await setup(t), child = h.child(); await h.poll();
  child.state = 'finished'; await h.poll(); await h.poll();
  assert.equal(h.bound(child).dormant, true); assert.equal(h.bound(child).frozen, false);
  assert.equal(h.bound().childrenCard.rows[0].status, 'finished');
  const notices = () => h.feishu.calls.filter(c => c.type === 'reply' && title(c)?.startsWith('已结束 ·'));
  assert.equal(notices().length, 1);
  assert.match(JSON.stringify(notices()[0].content), /子终端已结束.*|会话：Child session/);
  const topics = h.feishu.calls.filter(c => c.type === 'send').length;
  await h.restart(); await h.poll();
  assert.equal(notices().length, 1); assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, topics);
});

test('renames preserve own session identity while child root and parent rows follow the current names', async t => {
  const h = await setup(t), child = h.child(); await h.poll();
  h.parent.title = 'Parent renamed'; child.title = 'Child renamed'; child.name = 'w6-renamed';
  await h.poll(); await h.poll(10000);
  const binding = h.bound(child), root = h.feishu.calls.findLast(c => c.type === 'patch' && c.id === binding.topicId).card;
  assert.equal(root.header.title.content, '└ w6-renamed · Parent renamed');
  assert.match(root.body.elements[0].content, /会话：Child renamed/);
  assert.match(JSON.stringify(root), /父：Parent renamed/);
  assert.equal(h.bound().childrenCard.rows[0].name, 'w6-renamed');
  assert.equal(h.bound().childrenCard.rows[0].title, 'Child renamed');
});

test('lost child-root acknowledgement retries the durable UUID after restart instead of creating another topic', async t => {
  const h = await setup(t), send = h.feishu.send.bind(h.feishu), cached = new Map(), requests = [];
  let lost = false;
  h.feishu.send = async (chatId, content, uuid) => {
    requests.push(uuid);
    if (cached.has(uuid)) return cached.get(uuid);
    const id = await send(chatId, content, uuid); cached.set(uuid, id);
    if (!lost) { lost = true; throw Object.assign(new Error('lost acknowledgement'), { code: 'connection_closed' }); }
    return id;
  };
  const child = h.child(); await h.poll(); assert.equal(h.bound(child), undefined);
  assert.equal(h.bridge.store.data.childTopics.length, 1);
  await h.restart();
  assert.ok(h.bound(child)); assert.equal(requests.length, 2); assert.equal(requests[0], requests[1]);
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 2);
  assert.equal(h.bridge.store.data.childTopics.length, 0);
});

test('a lost parent-card reply reuses its pending payload and UUID after restart', async t => {
  const h = await setup(t), reply = h.feishu.reply.bind(h.feishu), cached = new Map(), requests = [];
  let lost = false;
  h.feishu.reply = async (topicId, content, type, uuid) => {
    if (!content?.header?.title.content.startsWith('子终端')) return reply(topicId, content, type, uuid);
    requests.push({ content, uuid }); if (cached.has(uuid)) return cached.get(uuid);
    const id = await reply(topicId, content, type, uuid); cached.set(uuid, id);
    if (!lost) { lost = true; throw new Error('lost acknowledgement'); }
    return id;
  };
  h.child(); await h.poll(); assert.ok(h.bound().childrenCard.pending);
  await h.restart(); await h.poll();
  assert.equal(requests.length, 2); assert.equal(requests[0].uuid, requests[1].uuid);
  assert.deepEqual(requests[0].content, requests[1].content);
  assert.equal(h.bound().childrenCard.pending, undefined);
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && title(c)?.startsWith('子终端')).length, 1);
});

test('fallback open/return actions bump only the linked topic, keep ACL/ownership checks and send no terminal input', async t => {
  const h = await setup(t, { links: false }), child = h.child(); await h.poll();
  const parent = h.bound(), binding = h.bound(child), count = mutations(h).length;
  const panel = h.feishu.calls.find(c => c.id === parent.childrenCard.cardId).content;
  const open = callbacks(panel).find(value => value.key === 'tree:open:0');
  const event = { kind: 'button', eventId: randomUUID(), chatId: parent.chatId, topicId: parent.topicId,
    messageId: parent.childrenCard.cardId, nonce: open.nonce, key: open.key, openId: 'ou_test' };
  await h.bridge.handle(event);
  assert.ok(h.feishu.calls.some(c => c.topicId === binding.topicId && typeof c.content === 'string' && c.content.startsWith('📍')));
  const root = h.feishu.calls.find(c => c.id === binding.topicId).text;
  const back = callbacks(root).find(value => value.key === 'tree:parent');
  await h.bridge.handle({ ...event, eventId: randomUUID(), topicId: undefined, messageId: binding.topicId, nonce: back.nonce, key: back.key });
  assert.ok(h.feishu.calls.some(c => c.topicId === parent.topicId && typeof c.content === 'string' && c.content.startsWith('📍')));
  const bumped = h.feishu.calls.filter(c => typeof c.content === 'string' && c.content.startsWith('📍')).length;
  for (const props of [{ nonce: 'forged' }, { messageId: binding.topicId }, { chatId: 'oc_foreign' }, { openId: 'ou_denied' }])
    await h.bridge.handle({ ...event, ...props, eventId: randomUUID() });
  assert.equal(h.feishu.calls.filter(c => typeof c.content === 'string' && c.content.startsWith('📍')).length, bumped);
  assert.equal(mutations(h).length, count);
});

test('manually opening a child races discovery without duplicate roots and explicit unbind is respected', async t => {
  const h = await setup(t), child = h.child();
  await Promise.all([h.poll(), h.bridge.handle(message(`/t open hc:${child.address}`, 'manual-child'))]);
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 2);
  const binding = h.bound(child);
  await h.bridge.store.unbind(binding.chatId, binding.topicId);
  await h.poll(); await h.poll(); assert.equal(h.bound(child), undefined);
  assert.equal(child.state, 'live'); assert.equal(mutations(h).length, 0);
  const panel = h.feishu.calls.findLast(c => c.type === 'patch' && c.id === h.bound().childrenCard.cardId).card;
  assert.equal(panel.header.title.content, '子终端 (0)');
  assert.match(JSON.stringify(panel), /暂无子终端/);
});

test('replacement child identities and backend outages do not publish false closing cards', async t => {
  const h = await setup(t), child = h.child(); await h.poll();
  child.created_ms++;
  await h.poll();
  assert.ok(h.bound(child).frozen);
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && title(c)?.startsWith('已结束 ·')).length, 0);
  const list = h.bridge.backend.backends.get('hc').list.bind(h.bridge.backend.backends.get('hc'));
  h.bridge.backend.backends.get('hc').list = async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }); };
  await h.poll();
  h.bridge.backend.backends.get('hc').list = list;
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && title(c)?.startsWith('已结束 ·')).length, 0);
});

test('moving a parent keeps child relations and replaces return links and the parent-card destination', async t => {
  const h = await setup(t), child = h.child(); await h.poll();
  const before = h.bound(), oldChildTopic = h.bound(child).topicId;
  await h.bridge.handle(message('/t move', 'move-parent', before.topicId));
  const moved = h.bound(); assert.notEqual(moved.topicId, before.topicId);
  assert.equal(h.bound(child).tree.parentTopicId, moved.topicId);
  await h.poll(); await h.poll(10000);
  assert.equal(h.bound(child).topicId, oldChildTopic);
  assert.ok(h.bound().childrenCard.cardId);
  const panel = h.feishu.calls.find(c => c.id === h.bound().childrenCard.cardId);
  assert.equal(panel.topicId, moved.topicId);
  const root = h.feishu.calls.findLast(c => c.type === 'patch' && c.id === oldChildTopic).card;
  assert.ok(JSON.stringify(root).includes(`omt_fixture_${moved.topicId}`));
});

test('a remote child resolves an unqualified parent address within its own machine namespace', async t => {
  const h = await setup(t);
  const remote = h.create({ address: 'peer/t1', parent: null, name: 'w6-remote', title: 'Remote parent' });
  await h.bridge.handle(message('/t open hc:peer/t1', 'open-remote'));
  const child = h.create({ address: 'peer/t2', parent: 't1', name: 'w6-remote-child' });
  await h.poll();
  assert.equal(h.bound(child).tree.parentTopicId, h.bound(remote).topicId);
  assert.equal(h.bound().childrenCard, undefined);
});

test('concurrent finish observations and a lost closing reply preserve one notice UUID through restart', async t => {
  const h = await setup(t), child = h.child(); await h.poll();
  const reply = h.feishu.reply.bind(h.feishu), cached = new Map(), requests = [];
  let lost = false;
  h.feishu.reply = async (topicId, content, type, uuid) => {
    if (!content?.header?.title.content.startsWith('已结束 ·')) return reply(topicId, content, type, uuid);
    requests.push(uuid); if (cached.has(uuid)) return cached.get(uuid);
    const id = await reply(topicId, content, type, uuid); cached.set(uuid, id);
    if (!lost) { lost = true; throw new Error('lost acknowledgement'); }
    return id;
  };
  child.state = 'finished'; const binding = h.bound(child);
  await Promise.all([h.bridge.wake.dormant(binding), h.bridge.wake.dormant(binding)]);
  assert.equal(h.bound(child).tree.notices.length, 1);
  await h.poll(); await h.restart(); await h.poll();
  assert.equal(requests.length, 2); assert.equal(requests[0], requests[1]);
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && title(c)?.startsWith('已结束 ·')).length, 1);
});

test('an explicitly recalled parent card gets one replacement and continues updating in place', async t => {
  const h = await setup(t), child = h.child(); await h.poll();
  const original = h.bound().childrenCard.cardId, patch = h.feishu.patch.bind(h.feishu);
  h.feishu.patch = async (id, value) => {
    if (id === original) throw Object.assign(new Error('recalled'), { code: '230011' });
    return patch(id, value);
  };
  child.status.state = 'working'; await h.poll(); await h.poll();
  const replacement = h.bound().childrenCard.cardId;
  assert.notEqual(replacement, original);
  child.status.state = 'done'; await h.poll(); await h.poll();
  assert.equal(h.bound().childrenCard.cardId, replacement);
  assert.equal(h.feishu.calls.filter(c => c.type === 'reply' && title(c)?.startsWith('子终端')).length, 2);
});
