import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeTranscript } from '../src/transcripts/claude.js';
import { emptyBackground, trackBackground, backgroundView, screenActivity, readBackgroundOutput } from '../src/transcripts/background.js';
import { turnCard } from '../src/render.js';
import { harness, message } from './helpers.js';
const start = { type: 'assistant', timestamp: '2026-11-02T00:00:00Z', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { run_in_background: true, description: 'Build project' } }] } };
const result = { type: 'user', toolUseResult: { backgroundTaskId: 'bg1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'Command running in background with ID: bg1. Output is being written to: /tmp/claude-1000/build.output' }] } };
const finish = status => ({ type: 'user', message: { content: `<task-notification><task-id>bg1</task-id><output-file>/tmp/claude-1000/build.output</output-file><status>${status}</status><summary>Background command "Build project" completed (exit code 255)</summary></task-notification>` } });

test('background start, all finish statuses and duplicate queue notification', () => {
  for (const status of ['completed', 'failed', 'killed']) {
    const bg = emptyBackground(); trackBackground(bg, start); trackBackground(bg, result);
    assert.equal(bg.running.length, 1); assert.equal(bg.running[0].tool, 'Bash');
    trackBackground(bg, finish(status)); trackBackground(bg, { type: 'queue-operation', content: finish(status).message.content });
    assert.equal(bg.running.length, 0); assert.equal(bg.finished.length, 1);
    assert.equal(bg.finished[0].exitCode, 255); assert.equal(bg.finished[0].status, status);
  }
});
test('restart streams a transcript larger than 10 MiB without replaying history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ft20-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, JSON.stringify(start) + '\n' + JSON.stringify(result) + '\n');
  const padding = JSON.stringify({ type: 'progress', data: 'x'.repeat(1000) }) + '\n';
  await appendFile(path, padding.repeat(11000));
  const adapter = new ClaudeTranscript(); const first = await adapter.read(path, { atEnd: true });
  assert.deepEqual(first.items, []); assert.equal(first.cursor.background.running.length, 1);
  const restarted = await new ClaudeTranscript().read(path, first.cursor);
  assert.equal(restarted.cursor.background.running[0].id, 'bg1');
  await appendFile(path, JSON.stringify(finish('completed')) + '\n');
  const done = await adapter.read(path, first.cursor);
  assert.equal(done.cursor.background.running.length, 0); assert.equal(done.cursor.background.finished.length, 1);
});
test('footer cross-check and visible spinner extraction', () => {
  const bg = emptyBackground(); trackBackground(bg, start); trackBackground(bg, result);
  assert.equal(backgroundView(bg, 'done 3:51 AM · 0 shells still running', Date.parse(start.timestamp) + 61000).running[0].status, 'unknown');
  assert.equal(backgroundView(bg, '⏵⏵ auto mode on · 1 shell · ↓ to manage', Date.parse(start.timestamp) + 61000).running[0].status, 'running');
  assert.equal(screenActivity('\x1b[31m✻ Thinking… (12s · ↑ 3k tokens)\x1b[0m').spinner, '✻ Thinking… (12s · ↑ 3k tokens)');
  assert.equal(screenActivity('✻ Sautéed for 22s').spinner, '✻ Sautéed for 22s');
});
test('background card renders running, unknown, grey finished tasks, button and settled header', () => {
  const bg = emptyBackground(); trackBackground(bg, start); trackBackground(bg, result);
  const turn = { agent: 'Claude', text: 'Answer', settled: true, background: backgroundView(bg, '', Date.parse(start.timestamp) + 720000) };
  let card = turnCard({ turn, topicId: 'topic', nonce: 'nonce' });
  assert.equal(card.header.template, 'wathet'); assert.match(card.header.title.content, /后台 1/);
  assert.match(JSON.stringify(card), /已运行 12 分钟/); assert.match(JSON.stringify(card), /background-output/);
  trackBackground(bg, finish('failed')); turn.background = backgroundView(bg, '', Date.now());
  card = turnCard({ turn }); assert.match(JSON.stringify(card), /grey.*失败（exit 255）/); assert.equal(card.header.template, 'green');
});
test('output rejects traversal, non-Claude paths and symlink escapes; tails and strips ANSI', async t => {
  for (const outputFile of ['/etc/passwd', '/tmp/claude-1000/../secret', '/tmp/claude-1000/a/../../secret', '/tmp/claude-1000/a\\secret']) await assert.rejects(readBackgroundOutput({ outputFile }));
  const root = '/tmp/claude-902020'; await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = root + '/safe.output'; await writeFile(path, Array.from({ length: 100 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`).join('\n'));
  const output = await readBackgroundOutput({ outputFile: path });
  assert.equal(output.split('\n').length, 30); assert.match(output, /line 99$/); assert.ok(!output.includes('\x1b'));
  const outside = resolve(root, '..', 'ft20-secret'); await writeFile(outside, 'secret'); t.after(() => rm(outside, { force: true }));
  await symlink(outside, root + '/escape.output');
  await assert.rejects(readBackgroundOutput({ outputFile: root + '/escape.output' }));
});
test('post-settle background patches are immediate for events, minute paced for elapsed, and move to the next turn', async t => {
  const bg = emptyBackground(); const records = [];
  const adapter = { locate: async () => 'fixture', read: async (_, cursor) => ({ items: cursor.atEnd ? [] : records.slice(cursor.offset), cursor: { offset: records.length, background: structuredClone(bg) } }) };
  const h = await harness(t, { adapters: { claude: adapter } }); const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working';
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const binding = () => h.bridge.store.forPane('w1:p1');
  const poll = async ms => { h.advance(ms); h.bridge.state(binding()).dirty = true; await h.bridge.tick(); };
  records.push({ role: 'assistant', text: 'Answer' }); trackBackground(bg, start); trackBackground(bg, result);
  bg.running[0].startedAt = new Date(h.bridge.now()).toISOString();
  await poll(0); const id = binding().cardId;
  pane.agent_status = 'done'; await poll(2000);
  assert.match(h.feishu.calls.filter(c => c.type === 'patch').at(-1).card.header.title.content, /后台 1/);
  const count = () => h.feishu.calls.filter(c => c.type === 'patch' && c.id === id).length;
  const before = count(); await poll(2000); assert.equal(count(), before);
  await poll(60000); assert.equal(count(), before + 1);
  records.push({ role: 'user', text: 'Next question' }, { role: 'assistant', text: 'Next answer' }); pane.agent_status = 'working';
  await poll(2000); await poll(2000);
  assert.notEqual(binding().cardId, id);
  const old = h.feishu.calls.filter(c => c.type === 'patch' && c.id === id).at(-1).card;
  assert.ok(!JSON.stringify(old).includes('后台运行中'));
  pane.agent_status = 'done'; await poll(2000);
  const settledCard = binding().cardId;
  trackBackground(bg, finish('completed')); await poll(2000);
  assert.equal(binding().cardId, settledCard);
  assert.match(JSON.stringify(h.feishu.calls.filter(c => c.type === 'patch').at(-1).card), /Build project 完成/);
});

test('background output callback uses ACL, current nonce, one-shot replay protection and no terminal keys', async t => {
  const bg = emptyBackground(); trackBackground(bg, start); trackBackground(bg, result);
  const records = [];
  const adapter = { locate: async () => 'fixture', read: async (_, c) => ({ items: c.atEnd ? [] : records.slice(c.offset), cursor: { offset: records.length, background: structuredClone(bg) } }) };
  const h = await harness(t, { adapters: { claude: adapter } }); const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working';
  await h.bridge.handle(message('/t open w1:p1', 'open')); records.push({ role: 'assistant', text: 'Answer' });
  const binding = () => h.bridge.store.forPane('w1:p1');
  h.bridge.state(binding()).dirty = true; await h.bridge.tick();
  const b = binding(); const click = (id, overrides = {}) => ({ kind: 'button', eventId: id, chatId: b.chatId, topicId: b.topicId, messageId: b.cardId, nonce: b.nonce, openId: 'ou_test', key: 'background-output', ...overrides });
  const output = () => h.feishu.calls.filter(c => c.content?.header?.title.content === '后台任务输出');
  await h.bridge.handle(click('denied', { openId: 'ou_intruder' })); assert.equal(output().length, 0);
  await h.bridge.handle(click('wrong', { nonce: 'wrong' })); assert.equal(output().length, 0);
  await h.bridge.handle(click('valid')); assert.equal(output().length, 1);
  await h.bridge.handle(click('replay')); assert.equal(output().length, 1);
  await h.restart(); await h.bridge.handle(click('restart-replay')); assert.equal(output().length, 1);
  assert.equal(h.fake.calls.filter(c => c.method === 'pane.send_keys').length, 0);
});
