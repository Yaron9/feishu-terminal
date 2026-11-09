// S8a2: a delivery without a topicId finds — or opens — the member's topic.
// Only the target resolution, the 📨 root message and the handover to the
// per-topic delivery matter here; the delivery itself is covered by S8a1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/bridge.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const roster = () => [
  { key: 'jia', name: '甲', cli: 'codex', cwd: '/tmp/jia' },
  { key: 'yi', name: '乙', cli: 'codex', cwd: '/tmp/yi' },
];

function fakes({ rows = [], group } = {}) {
  const owner = group === undefined ? { chatId: 'oc', project: '查理芒格', cli: 'codex', cwd: '/tmp', members: roster() } : group;
  const bridge = Object.create(Bridge.prototype), posts = [], calls = [], delivered = [];
  const bindings = new Map(rows.map(row => [`${row.chatId}:${row.topicId}`, row]));
  const binding = (chatId, topicId) => bindings.get(`${chatId}:${topicId}`);
  Object.assign(bridge, {
    deliveryChains: new Map(), deliveryEvents: new EventEmitter(), queues: new Map(),
    registry: { get: chatId => owner && chatId === 'oc' ? owner : null },
    store: { data: {}, binding, list: () => [...bindings.values()].map(row => structuredClone(row)) },
    feishu: {
      send: async (chatId, text) => { posts.push({ chatId, text }); return `root-${posts.length}`; },
      reply: async () => 'card',
    },
    onError: () => {},
    input: async (item, text) => { delivered.push({ kind: 'input', topicId: item.topicId, text }); },
    wake: { route: async (item, action) => {
      delivered.push({ kind: 'wake', topicId: item.topicId, text: action.text }); item.dormant = false;
    } },
    // The real creation paths: only the contract deliver has with them is
    // asserted, and the binding each one writes is reproduced faithfully.
    async createMemberTopic(event, action, chat, { member, prompt }, options = {}) {
      calls.push({ path: 'createMemberTopic', event, action, member, prompt, options, group: chat });
      bindings.set(`oc:${event.messageId}`, { chatId: 'oc', topicId: event.messageId, member: member.key,
        memberName: member.name, sessionId: `session-${event.messageId}`, dormant: true,
        topicRoot: { type: 'user', text: action.text },
        queuedInputs: options.queue === false ? [] : [{ text: prompt }] });
      return true;
    },
    async createDormantTopic(event, action, row, chat, member = null, options = {}) {
      calls.push({ path: 'createDormantTopic', event, action, row, member, options, group: chat });
      bindings.set(`oc:${event.messageId}`, { chatId: 'oc', topicId: event.messageId, cli: row.cli,
        sessionId: `session-${event.messageId}`, dormant: true, topicRoot: { type: 'user', text: action.text },
        queuedInputs: options.queue === false ? [] : [{ text: action.text }] });
    },
  });
  const deliver = (fields = {}) => bridge.deliver({ chatId: 'oc', from: '测试员', timeoutMs: 2000, ...fields });
  const settle = (topicId, turnId, text) => bridge.deliveryEvents.emit('turnSettled',
    { chatId: 'oc', topicId, turnId, text, sessionId: `session-${topicId}` });
  return { bridge, posts, calls, delivered, binding, deliver, settle };
}

test('a member delivery picks the most recent topic of that member', async () => {
  const f = fakes({ rows: [
    { chatId: 'oc', topicId: 'old', member: 'jia', lastInputAt: 100, sessionId: 'session-old' },
    { chatId: 'oc', topicId: 'new', member: 'jia', lastInputAt: 500, sessionId: 'session-new' },
  ] });
  const done = f.deliver({ member: 'jia', text: '在吗' });
  await pause();
  assert.equal(f.posts.length, 0, 'an existing topic needs no root message');
  assert.deepEqual(f.calls, [], 'nothing is created');
  assert.deepEqual(f.delivered, [{ kind: 'input', topicId: 'new', text: '[来自 测试员]\n在吗' }]);
  f.settle('new', 't1', '在');
  assert.deepEqual(await done, { answer: '在', sessionId: 'session-new' });
});

test('other members topics, other groups and frozen bindings are ignored', async () => {
  const f = fakes({ rows: [
    { chatId: 'oc', topicId: 'yi-newest', member: 'yi', lastInputAt: 900 },
    { chatId: 'oc', topicId: 'frozen', member: 'jia', frozen: true, lastInputAt: 800 },
    { chatId: 'oc_other', topicId: 'elsewhere', member: 'jia', lastInputAt: 700 },
    { chatId: 'oc', topicId: 'mine', member: 'jia', lastInputAt: 200 },
    { chatId: 'oc', topicId: 'group-only', lastInputAt: 600 },
  ] });
  const done = f.deliver({ member: 'jia', text: '在吗' });
  await pause();
  assert.equal(f.delivered.length, 1);
  assert.equal(f.delivered[0].topicId, 'mine');
  f.settle('mine', 't1', '在');
  assert.equal((await done).answer, '在');
});

test('a null member picks the group own most recent topic', async () => {
  const f = fakes({ rows: [
    { chatId: 'oc', topicId: 'main', lastInputAt: 10 },
    { chatId: 'oc', topicId: 'jia-newer', member: 'jia', lastInputAt: 999 },
  ] });
  const done = f.deliver({ text: '在吗' });
  await pause();
  assert.equal(f.delivered[0]?.topicId, 'main');
  f.settle('main', 't1', '在');
  assert.equal((await done).answer, '在');
});

test('no topic: the bot posts the 📨 root and opens the member topic with nothing queued', async () => {
  const f = fakes();
  const done = f.deliver({ member: 'jia', text: '你是谁？只回一句' });
  await pause();
  assert.deepEqual(f.posts, [{ chatId: 'oc', text: '📨 测试员 → 甲：你是谁？只回一句' }]);
  assert.equal(f.calls.length, 1, 'exactly one member topic is created');
  const call = f.calls[0];
  assert.equal(call.path, 'createMemberTopic');
  assert.equal(call.member.key, 'jia');
  assert.equal(call.options.queue, false, 'the root message is not a queued prompt');
  assert.equal(call.action.text, f.posts[0].text, 'the 📨 message is the topic root');
  assert.equal(call.event.messageId, 'root-1');
  assert.equal(call.event.text, f.posts[0].text);
  assert.equal(f.binding('oc', 'root-1').member, 'jia', 'the binding carries the member');
  assert.deepEqual(f.binding('oc', 'root-1').queuedInputs, []);
  assert.deepEqual(f.delivered, [{ kind: 'wake', topicId: 'root-1', text: '[来自 测试员]\n你是谁？只回一句' }]);
  f.settle('root-1', 't1', '我是测试成员甲');
  assert.deepEqual(await done, { answer: '我是测试成员甲', sessionId: 'session-root-1' });
});

test('the 📨 root carries the first 60 characters of the text', async () => {
  const f = fakes();
  const text = '字'.repeat(59) + '结尾';
  const done = f.deliver({ member: 'jia', text });
  await pause();
  assert.equal(f.posts[0].text, `📨 测试员 → 甲：${'字'.repeat(59)}结`);
  f.settle('root-1', 't1', '好');
  assert.equal((await done).answer, '好');
});

test('no topic and no member: the group default CLI opens a topic with nothing queued', async () => {
  const f = fakes();
  const done = f.deliver({ text: '群里的第一条' });
  await pause();
  assert.deepEqual(f.posts, [{ chatId: 'oc', text: '📨 测试员 → 查理芒格：群里的第一条' }]);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.path, 'createDormantTopic');
  assert.equal(call.row.cli, 'codex');
  assert.equal(call.member, null);
  assert.equal(call.options.queue, false);
  assert.equal(call.action.text, f.posts[0].text);
  assert.equal(f.binding('oc', 'root-1').member, undefined, 'a group topic has no member');
  assert.deepEqual(f.binding('oc', 'root-1').queuedInputs, []);
  f.settle('root-1', 't1', '收到');
  assert.equal((await done).answer, '收到');
});

test('a second member delivery reuses the topic the first one opened', async () => {
  const f = fakes();
  const first = f.deliver({ member: 'jia', text: '你是谁' });
  await pause();
  f.settle('root-1', 't1', '我是测试成员甲');
  assert.equal((await first).answer, '我是测试成员甲');
  f.binding('oc', 'root-1').lastInputAt = 42;
  const second = f.deliver({ member: 'jia', text: '再说一次' });
  await pause();
  assert.equal(f.posts.length, 1, 'no second root message');
  assert.equal(f.calls.length, 1, 'no second topic');
  assert.equal(f.delivered.at(-1).topicId, 'root-1');
  assert.equal(f.delivered.at(-1).text, '[来自 测试员]\n再说一次');
  f.settle('root-1', 't2', '我是测试成员甲');
  assert.equal((await second).answer, '我是测试成员甲');
});

test('an unknown member rejects with no_member before anything is posted', async () => {
  const f = fakes();
  await assert.rejects(f.deliver({ member: 'nobody', text: '在吗' }), { code: 'no_member' });
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.delivered, []);
});

test('a group outside the registry rejects with no_group', async () => {
  const f = fakes({ group: null });
  await assert.rejects(f.deliver({ member: 'jia', text: '在吗' }), { code: 'no_group' });
  await assert.rejects(f.deliver({ text: '在吗' }), { code: 'no_group' });
  assert.deepEqual(f.posts, []);
});