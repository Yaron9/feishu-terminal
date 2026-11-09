import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageReader, formatUsage } from '../src/usage.js';
import { legacyHarness as harness, message } from './helpers.js';

const NOW = Date.parse('2026-11-08T08:30:00Z');
function account(overrides = {}) {
  return { number: 1, email: 'private@example.com', usageStatus: 'ok',
    usageFetchedAt: '2026-11-08T08:20:00Z',
    usage: { fiveHour: { pct: 81, resetsAt: '2026-11-08T11:00:00Z' },
      sevenDay: { pct: 2 } }, ...overrides };
}
const payload = (...accounts) => ({ schemaVersion: 1, accounts });

test('cswap used percentages become masked remaining percentages with accurate freshness', () => {
  const text = formatUsage(payload(account()), NOW);
  assert.match(text, /已识别 1 个账号/);
  assert.match(text, /#1 p\*\*\*@example\.com/);
  assert.doesNotMatch(text, /private@example\.com/);
  assert.match(text, /近期数据/);
  assert.match(text, /五小时剩余 19% · 重置 11-08 19:00 北京时间/);
  assert.match(text, /每周剩余 98% · 重置 未知/);
  assert.match(text, /非 token 数/);
});

test('expired accounts, missing timestamps and invalid percentages are never shown as fresh', () => {
  const expired = account({ number: 2, usageStatus: 'relogin_required', usage: null,
    usageFetchedAt: undefined, lastGoodFetchedAt: '2026-11-07T08:20:00Z',
    lastGoodUsage: { fiveHour: { pct: 87 }, sevenDay: { pct: null } } });
  const invalid = account({ number: 3, usageFetchedAt: undefined,
    usage: { fiveHour: { pct: true }, sevenDay: { pct: 101 } } });
  const text = formatUsage(payload(expired, invalid), NOW);
  assert.match(text, /需要重新登录/);
  assert.match(text, /实时性待确认/);
  assert.match(text, /五小时剩余 13%/);
  assert.match(text, /每周额度暂不可用/);
  assert.match(text, /五小时额度暂不可用/);
  assert.doesNotMatch(text, /近期数据/);
  assert.throws(() => formatUsage({ schemaVersion: 2, accounts: [] }, NOW));
});

test('concurrent queries are coalesced and cached without exposing errors', async () => {
  let calls = 0, clock = NOW, finish;
  const reader = createUsageReader({ now: () => clock, memory: async () => true, cacheMs: 60000,
    run: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const a = reader(), b = reader();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); finish(payload(account()));
  assert.equal(await a, await b);
  await reader(); assert.equal(calls, 1);
  clock += 60001;
  const c = reader(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); finish(payload(account())); await c;
});

test('failures and low memory never leak process output or pretend cached data is fresh', async () => {
  let ok = true, clock = NOW, runs = 0;
  const reader = createUsageReader({ now: () => clock, cacheMs: 10, memory: async () => ok,
    run: async () => { runs++; if (runs > 1) throw new Error('secret process output'); return payload(account()); } });
  assert.match(await reader(), /近期数据/);
  clock += 11;
  let text = await reader(); assert.match(text, /实时性待确认/); assert.doesNotMatch(text, /secret/);
  ok = false; text = await reader(); assert.match(text, /实时性待确认/); assert.equal(runs, 2);
  const empty = createUsageReader({ memory: async () => false, run: async () => { throw new Error('must not run'); } });
  assert.match(await empty(), /暂时无法读取/);
});

test('authorized /usage is intercepted at group root and in topics without terminal input', async t => {
  let reads = 0;
  const h = await harness(t, { readUsage: async () => { reads++; return 'masked quota'; } });
  await h.bridge.handle(message('/usage', 'u1'));
  assert.equal(reads, 1);
  assert.ok(h.feishu.calls.some(c => c.type === 'send' && c.text === 'masked quota'));
  assert.equal(h.fake.calls.filter(c => ['workspace.create', 'pane.send_text', 'agent.prompt'].includes(c.method)).length, 0);
  await h.bridge.handle(message(' /usage ', 'u2', 'topic'));
  assert.equal(reads, 2);
  assert.ok(h.feishu.calls.some(c => c.type === 'reply' && c.topicId === 'topic' && c.content === 'masked quota'));
  assert.equal(h.fake.calls.filter(c => ['workspace.create', 'pane.send_text', 'agent.prompt'].includes(c.method)).length, 0);
});

test('authorized private /usage works without allowing other private commands or unknown groups', async t => {
  let reads = 0;
  const h = await harness(t, { readUsage: async () => { reads++; return 'masked quota'; } });
  await h.bridge.handle(message('/usage', 'private', 'private', { chatId: 'oc_private', chatType: 'p2p' }));
  assert.equal(reads, 1);
  assert.ok(h.feishu.calls.some(c => c.type === 'send' && c.chatId === 'oc_private' && c.text === 'masked quota'));
  await h.bridge.handle(message('/usage', 'bad-private', 'bad-private', { chatId: 'oc_private', chatType: 'p2p', openId: 'ou_bad' }));
  await h.bridge.handle(message('/usage', 'unknown-group', 'unknown-group', { chatId: 'oc_other' }));
  await h.bridge.handle(message('pwd', 'private-command', 'private-command', { chatId: 'oc_private', chatType: 'p2p' }));
  assert.equal(reads, 1);
  assert.equal(h.fake.calls.filter(c => ['workspace.create', 'pane.send_text', 'agent.prompt'].includes(c.method)).length, 0);
});

test('unauthorized /usage does not query; reader failure produces a safe response', async t => {
  let calls = 0;
  const h = await harness(t, { readUsage: async () => { calls++; throw new Error('private token'); } });
  await h.bridge.handle(message('/usage', 'bad', 'bad', { openId: 'ou_bad' }));
  assert.equal(calls, 0);
  await h.bridge.handle(message('/usage', 'good', 'good'));
  assert.equal(calls, 1);
  const result = h.feishu.calls.find(c => c.type === 'send' && String(c.text).includes('暂时无法读取'));
  assert.ok(result); assert.doesNotMatch(String(result.text), /private token/);
});

test('non-exact /usage text remains normal terminal input', async t => {
  let calls = 0;
  const h = await harness(t, { readUsage: async () => { calls++; return 'wrong'; } });
  await h.bridge.handle(message('pwd'));
  await h.bridge.handle(message('/usage details', 'm2', 'm1'));
  assert.equal(calls, 0);
  assert.ok(h.fake.calls.some(c => c.method === 'pane.send_text' && c.params.text === '/usage details'));
});
