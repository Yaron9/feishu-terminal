import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeTranscript, claudeItems } from '../src/transcripts/claude.js';
import { legacyHarness as harness, message } from './helpers.js';

async function setup(t) {
  const records = []; let duplicates = [];
  const adapter = { transcriptTurns: true, locate: async () => 'turns.jsonl',
    read: async (_path, cursor) => ({ cursor: { offset: records.length, duplicates },
      items: cursor.atEnd ? [] : records.slice(cursor.offset) }) };
  const h = await harness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'idle';
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const binding = () => h.bridge.store.forPane('w1:p1');
  const poll = async (ms = 2000) => {
    h.advance(ms); h.bridge.state(binding()).dirty = true; await h.bridge.tick();
  };
  const cards = () => h.feishu.calls.filter(c => c.type === 'reply' && c.content?.header?.title.content.startsWith('🤖 '));
  return { h, pane, records, binding, poll, cards, duplicates(value) { duplicates = value; } };
}

test('two writers interleave under idle herdr on one card until turn_duration, then a real prompt starts another', async t => {
  const { h, records, binding, poll, cards } = await setup(t);
  records.push({ role: 'user', text: 'prompt' }, { role: 'assistant', text: 'writer one' }); await poll();
  const id = binding().cardId;
  for (let i = 0; i < 12; i++) {
    records.push({ role: i % 2 ? 'assistant' : 'tool', text: `writer ${i}` }); await poll();
    assert.equal(binding().turn.settled, false);
  }
  assert.equal(cards().length, 1); assert.equal(binding().cardId, id);
  assert.ok(h.feishu.calls.filter(c => c.type === 'patch' && c.id === id).length >= 12);
  records.push(...claudeItems({ type: 'system', subtype: 'turn_duration' })); await poll();
  assert.equal(binding().turn.settled, true); assert.equal(binding().cardId, id);
  records.push({ role: 'user', text: 'next prompt' }, { role: 'assistant', text: 'next answer' });
  await poll(); assert.equal(cards().length, 2); assert.notEqual(binding().cardId, id);
});

test('tool results, task notifications, meta, compact summaries, commands and ignored record types cannot start turns', () => {
  for (const record of [
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'result' }, { type: 'text', text: 'result wrapper' }] } },
    ...['<task-notification>task</task-notification>', '<command-name>/clear</command-name>', '<local-command-stdout>x</local-command-stdout>'].map(content => ({ type: 'user', message: { content } })),
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', isCompactSummary: true, message: { content: 'summary' } },
    { type: 'api-request', message: { content: 'request' } }, { type: 'attachment', message: { content: 'attachment' } },
  ]) assert.deepEqual(claudeItems(record), []);
  for (const content of ['real prompt', [{ type: 'text', text: 'real prompt' }]])
    assert.equal(claudeItems({ type: 'user', message: { content } })[0].role, 'user');
});

test('fallback needs 30 seconds without transcript activity and herdr not working, including across restart', async t => {
  const { h, pane, records, binding, poll } = await setup(t);
  records.push({ role: 'user', text: 'old client' }, { role: 'assistant', text: 'answer' }); await poll();
  await poll(29000); assert.equal(binding().turn.settled, false);
  records.push({ role: 'tool', text: 'late activity' }); await poll();
  await h.restart(); pane.agent_status = 'working'; await poll(31000);
  assert.equal(binding().turn.settled, false);
  pane.agent_status = 'idle'; await poll(); assert.equal(binding().turn.settled, true);
});

test('duplicate warning decorates a card, rate limits topic messages across restart and clears on exit', async t => {
  const s = await setup(t); const { h, records, binding, poll, cards } = s;
  s.duplicates([442803]); records.push({ role: 'user', text: 'prompt' }, { role: 'assistant', text: 'answer' }); await poll();
  const notices = () => h.feishu.calls.filter(c => c.type === 'reply' && typeof c.content === 'string' && c.content.includes('PID 442803'));
  assert.equal(notices().length, 1); assert.match(binding().turn.duplicateWarning, /PID 442803/);
  assert.match(JSON.stringify(cards()[0].content), /PID 442803/);
  await h.restart(); await poll(); assert.equal(notices().length, 1);
  s.duplicates([]); await poll(); assert.equal(binding().turn.duplicateWarning, '');
  assert.ok(!JSON.stringify(h.feishu.calls.filter(c => c.type === 'patch').at(-1).card).includes('PID 442803'));
  s.duplicates([442803]); await poll(); assert.equal(notices().length, 1);
  await poll(3600000); assert.equal(notices().length, 2);
});

test('duplicate detection projects only pid/sessionId, checks live claude comm, ignores key files and drops exited processes', async t => {
  const root = await mkdtemp(new URL('../.test-ft24-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, '.claude', 'sessions'), proc = join(root, 'proc');
  await mkdir(sessions, { recursive: true });
  const adapter = new ClaudeTranscript({ home: root, procRoot: proc });
  adapter.sessions.set('transcript', { pid: 1, sessionId: 'same' });
  for (const [pid, sessionId, comm] of [[1, 'same', 'claude'], [2, 'same', 'claude'], [3, 'other', 'claude'], [4, 'same', 'bash'], [5, 'same', null]]) {
    await writeFile(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, secret: 'NEVER_LOG_SESSION_EXTRA', cwd: 'ignored' }));
    if (comm) { await mkdir(join(proc, String(pid)), { recursive: true }); await writeFile(join(proc, String(pid), 'comm'), comm + '\n'); }
  }
  await mkdir(join(sessions, '6.key')); await writeFile(join(sessions, 'junk.json'), 'invalid');
  const result = await adapter.duplicates('transcript');
  assert.deepEqual(result, [2]); assert.ok(!JSON.stringify(result).includes('NEVER_LOG_SESSION_EXTRA'));
  await rm(join(proc, '2'), { recursive: true }); assert.deepEqual(await adapter.duplicates('transcript'), []);
});
