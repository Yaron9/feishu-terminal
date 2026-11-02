import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTranscript, projectDirectory } from '../src/transcripts/claude.js';
import { emptyBackground, trackBackground, backgroundView, screenActivity } from '../src/transcripts/background.js';
import { turnCard } from '../src/render.js';
const timestamp = '2026-11-02T00:00:00Z';
const start = (id = 'old', ts = timestamp) => [
  { type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { run_in_background: true, description: `Build ${id}` } }] } },
  { type: 'user', toolUseResult: { backgroundTaskId: id }, message: { content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } },
];
const notification = (id, status, summary = '', ts = '2026-11-02T00:02:00Z') => ({ type: 'user', timestamp: ts, message: { content: `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>${summary}</summary></task-notification>` } });
const lines = records => records.map(r => JSON.stringify(r) + '\n').join('');
const background = () => { const bg = emptyBackground(); start().forEach(r => trackBackground(bg, r)); return bg; };

test('stopped and unknown notification statuses terminate and render known tasks', () => {
  for (const [status, label] of [['stopped', '已停止'], ['cancelled-by-host', 'cancelled-by-host']]) {
    const bg = background(); trackBackground(bg, notification('old', status));
    assert.equal(bg.running.length, 0); assert.equal(bg.finished[0].status, status);
    const card = turnCard({ turn: { agent: 'Claude', text: '', settled: true, background: bg } });
    assert.ok(JSON.stringify(card).includes(`⏹ Build old ${label}`));
  }
});

test('restart rebuild clears persisted stale tasks from stopped notifications', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ft23-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.jsonl'); await writeFile(path, lines(start()));
  const stale = await new ClaudeTranscript().read(path, { atEnd: true });
  assert.equal(stale.cursor.background.running.length, 1);
  await appendFile(path, lines([notification('old', 'stopped')]));
  const rebuilt = await new ClaudeTranscript().read(path, JSON.parse(JSON.stringify(stale.cursor)));
  assert.equal(rebuilt.cursor.background.running.length, 0);
  assert.equal(rebuilt.cursor.background.finished[0].status, 'stopped');
});

test('absent count on Claude footer/prompt is zero only after one minute; no footer makes no judgement', () => {
  const bg = background();
  for (const screen of ['⏵⏵ auto mode on', '❯ ', '? for shortcuts', '⏵⏵ bypass permissions on (shift+tab to cycle)']) {
    assert.equal(screenActivity(screen).footerCount, 0);
    assert.equal(backgroundView(bg, screen, Date.parse(timestamp) + 60000).running[0].status, 'running');
    assert.equal(backgroundView(bg, screen, Date.parse(timestamp) + 60001).running[0].status, 'unknown');
  }
  for (const screen of ['', 'Repainting...', 'Choose model\n❯ Default\n  Fast', '❯ 1. Yes\n  2. No']) {
    assert.equal(screenActivity(screen).footerCount, null);
    assert.equal(backgroundView(bg, screen, Date.parse(timestamp) + 60001).running[0].status, 'running');
  }
  assert.equal(screenActivity('⏵⏵ auto mode on · 2 agents · ↓ to manage').footerCount, 2);
});

test('previous-session notification stops earlier tasks, preserves newer tasks and allows later outcomes', () => {
  const bg = background(); start('other-old').forEach(r => trackBackground(bg, r));
  start('new', '2026-11-02T00:03:00Z').forEach(r => trackBackground(bg, r));
  trackBackground(bg, notification('old', 'stopped', "Background shell command didn't finish before the previous session ended"));
  assert.deepEqual(bg.running.map(t => t.id), ['new']);
  assert.equal(bg.finished[0].status, 'stopped');
  trackBackground(bg, notification('old', 'completed'));
  assert.equal(bg.finished.find(t => t.id === 'old').status, 'completed');
});

test('new PID for the same session stops older tasks, survives adapter restart and accepts later completion', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ft23-pid-')); t.after(() => rm(home, { recursive: true, force: true }));
  const procRoot = join(home, 'proc'), sessions = join(home, '.claude', 'sessions');
  const project = join(home, '.claude', 'projects', projectDirectory('/repo'));
  await mkdir(project, { recursive: true }); await mkdir(sessions, { recursive: true });
  const path = join(project, 'same.jsonl'); await writeFile(path, lines(start()));
  async function process(pid, time) {
    const base = join(procRoot, String(pid)); await mkdir(base, { recursive: true });
    await writeFile(join(base, 'comm'), 'claude'); await writeFile(join(base, 'environ'), 'HERDR_PANE_ID=pane\0');
    await writeFile(join(base, 'stat'), `${pid} (claude) S ${Array(18).fill('0').join(' ')} ${pid} 0`);
    const session = join(sessions, `${pid}.json`);
    await writeFile(session, JSON.stringify({ pid, cwd: '/repo', sessionId: 'same' }));
    await utimes(session, new Date(time), new Date(time));
  }
  const adapter = new ClaudeTranscript({ home, procRoot });
  await process(100, timestamp); await adapter.locate({ pane_id: 'pane' });
  const old = await adapter.read(path, { atEnd: true });
  await process(200, '2026-11-02T00:02:00Z');
  await appendFile(path, lines(start('new', '2026-11-02T00:03:00Z')));
  await adapter.locate({ pane_id: 'pane' });
  const stopped = await adapter.read(path, old.cursor);
  assert.deepEqual(stopped.cursor.background.running.map(t => t.id), ['new']);
  assert.equal(stopped.cursor.background.finished[0].status, 'stopped');
  const restarted = new ClaudeTranscript({ home, procRoot }); await restarted.locate({ pane_id: 'pane' });
  const rebuilt = await restarted.read(path, old.cursor);
  assert.deepEqual(rebuilt.cursor.background.running.map(t => t.id), ['new']);
  const again = new ClaudeTranscript({ home, procRoot }); await again.locate({ pane_id: 'pane' });
  const restored = await again.read(path, JSON.parse(JSON.stringify(stopped.cursor)));
  assert.deepEqual(restored.cursor.background.running.map(t => t.id), ['new']);
  await appendFile(path, lines([notification('old', 'completed')]));
  const done = await adapter.read(path, stopped.cursor);
  assert.equal(done.cursor.background.finished[0].status, 'completed');
});
