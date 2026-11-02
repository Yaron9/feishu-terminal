import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ClaudeTranscript } from '../src/transcripts/claude.js';
import { emptyBackground, trackBackground } from '../src/transcripts/background.js';
import { harness, message } from './helpers.js';
import { Feishu } from '../src/feishu.js';

test('card schemas expire after 14 days across restart while active roots, menu, turn and pending/retired cards retain exact schema', async t => {
  const dir = await mkdtemp(new URL('../.test-ft26-', import.meta.url)); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 0;
  const file = join(dir, 'state.json');
  const store = await new Store(file, { now: () => now }).load();
  const binding = { chatId: 'chat', topicId: 'root', paneId: 'pane', cardId: 'turn', menuCardId: 'menu', retiredCardId: 'retiring',
    pendingCard: { targetId: 'pending', previousCardId: 'previous' } };
  await store.bind(binding);
  await store.transaction(data => { data.cardSchemas = Object.fromEntries(['root', 'turn', 'menu', 'retiring', 'pending', 'previous', 'history'].map(id =>
    [id, { schemaVersion: id === 'menu' ? '2.0' : '1.0', updatedAt: now }])); });
  now = 14 * 86400000 - 1; await store.maintain(now);
  assert.ok(store.data.cardSchemas.history);
  now++;
  const restarted = await new Store(file, { now: () => now }).load();
  assert.equal(restarted.data.cardSchemas.history, undefined);
  for (const id of ['root', 'turn', 'menu', 'retiring', 'pending', 'previous']) assert.ok(restarted.data.cardSchemas[id]);
  assert.equal(restarted.data.cardSchemas.menu.schemaVersion, '2.0');
  await restarted.unbind('chat', 'root');
  assert.deepEqual(restarted.data.cardSchemas, {});
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).cardSchemas, {});
});

test('card-schema count limit retains the newest entries on timestamp ties, pins active cards and migrates legacy metadata once', async t => {
  const dir = await mkdtemp(new URL('../.test-ft26-', import.meta.url)); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(join(dir, 'state.json'), { now: () => 123, cardSchemaLimit: 2 }).load();
  await store.bind({ chatId: 'chat', topicId: 'root', paneId: 'pane', cardId: 'active' });
  await store.transaction(data => { data.cardSchemas = Object.fromEntries(['active', 'a', 'b', 'c'].map(id => [id, { schemaVersion: '2.0' }])); });
  assert.deepEqual(Object.keys(store.data.cardSchemas), ['active', 'b', 'c']);
  assert.equal(store.data.cardSchemas.c.updatedAt, 123);
});

test('large persisted picker, pointer, ownership and dedupe histories are bounded on load with active ownership retained', async t => {
  const dir = await mkdtemp(new URL('../.test-ft26-', import.meta.url)); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  await writeFile(file, JSON.stringify({ version: 1,
    bindings: [{ chatId: 'chat', topicId: 'topic', paneId: 'pane', identity: { terminalId: 'old-active' } }],
    seen: Array.from({ length: 12000 }, (_, i) => `event-${i}`),
    actionCards: Array.from({ length: 600 }, (_, i) => ({ messageId: `card-${i}` })),
    topicPointers: Array.from({ length: 12000 }, (_, i) => ({ oldTopicId: `topic-${i}` })),
    createdTerminals: ['old-active', ...Array.from({ length: 12000 }, (_, i) => `terminal-${i}`)],
  }));
  const store = await new Store(file).load();
  assert.equal(store.data.seen.length, 10000); assert.equal(store.data.actionCards.length, 512);
  assert.equal(store.data.topicPointers.length, 10000); assert.equal(store.data.createdTerminals.length, 10001);
  assert.ok(store.data.createdTerminals.includes('old-active'));
});

test('idle bridge maintenance expires picker cards and removes runtime entries for unbound topics', async t => {
  const h = await harness(t);
  await h.store.saveActionCard({ messageId: 'expired', createdAt: 0 }, 0);
  h.bridge.runtime.set('unbound', { current: 'old screen' });
  h.advance(600000); await h.bridge.tick();
  assert.equal(h.store.data.actionCards.length, 0); assert.equal(h.bridge.runtime.size, 0);
});

test('transcript caches stay bounded while evicted sessions rebuild background state from disk', async t => {
  const dir = await mkdtemp(new URL('../.test-ft26-', import.meta.url)); t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = new ClaudeTranscript({ cacheLimit: 3 });
  for (let i = 0; i < 10; i++) {
    const file = join(dir, `session-${i}.jsonl`);
    const record = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { run_in_background: true, description: 'job' } }] } };
    await writeFile(file, JSON.stringify(record) + '\n');
    await adapter.read(file, { atEnd: true });
    adapter.remember(adapter.sessions, file, { sessionId: String(i) });
    assert.ok(adapter.backgrounds.size <= 3); assert.ok(adapter.sessions.size <= 3);
  }
  assert.equal(adapter.backgrounds.has(join(dir, 'session-0.jsonl')), false);
  const rebuilt = await adapter.read(join(dir, 'session-0.jsonl'), { atEnd: true });
  assert.equal(rebuilt.cursor.background.pending.tool.description, 'job');
  assert.equal(adapter.backgrounds.size, 3);
});

test('background running and pending registries cap abandoned tasks and keep the latest jobs', () => {
  const state = emptyBackground();
  for (let i = 0; i < 550; i++) {
    trackBackground(state, { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool-${i}`, input: { run_in_background: true } }] } });
    trackBackground(state, { type: 'user', toolUseResult: { backgroundTaskId: `job-${i}` },
      message: { content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: '' }] } });
  }
  assert.equal(state.running.length, 500); assert.equal(state.running[0].id, 'job-50');
  for (let i = 0; i < 550; i++) trackBackground(state, { type: 'assistant', message: { content: [{ type: 'tool_use', id: `pending-${i}`, input: { run_in_background: true } }] } });
  assert.equal(Object.keys(state.pending).length, 500); assert.ok(state.pending['pending-549']);
});

test('thread history rejects cyclic pagination rather than growing forever', async () => {
  let page = 0;
  const edge = new Feishu({ client: { im: { message: { list: async () => {
    edge.nextSend = 0; return { code: 0, data: { items: [], has_more: true, page_token: ['a', 'b'][page++ % 2] } };
  } } } }, ws: { close() {} } });
  await assert.rejects(edge.threadMessages('thread'), { code: 'invalid_pagination' });
  assert.equal(page, 3);
});

test('successive real turn publications retain bounded completed-task suppression history', async t => {
  const records = [], background = emptyBackground();
  const adapter = { locate: async () => 'fixture', read: async (_, cursor) => ({ items: cursor.atEnd ? [] : records.slice(cursor.offset),
    cursor: { offset: records.length, background: structuredClone(background) } }) };
  const h = await harness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working';
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  for (let i = 0; i < 15; i++) {
    background.finished = [{ id: `finished-${i}`, description: `job-${i}`, status: 'completed' }];
    records.push({ role: 'user', text: `question-${i}` }, { role: 'assistant', text: `answer-${i}` });
    for (let j = 0; j < 2; j++) { h.advance(2000); await h.bridge.tick(); }
  }
  const turn = h.store.forPane('w1:p1').turn;
  assert.equal(turn.text, 'answer-14');
  assert.equal(turn.backgroundFinishedBefore.length, 10);
  assert.ok(turn.backgroundFinishedBefore.includes('finished-13'));
  assert.ok(!turn.backgroundFinishedBefore.includes('finished-0'));
});
