import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeTranscript, claudeItems, projectDirectory } from '../src/transcripts/claude.js';
import { paneProcess } from '../src/transcripts/proc.js';
import { CodexTranscript } from '../src/transcripts/codex.js';

async function fixture(t) {
  const root = await mkdtemp(new URL('../.test-transcript-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: join(root, 'session.jsonl'), adapter: new ClaudeTranscript({ home: root, procRoot: join(root, 'proc') }) };
}
const line = text => JSON.stringify({ type: 'user', uuid: text, message: { content: text } }) + '\n';

test('Claude fixture projects only real user/assistant text and compact tool summaries', async t => {
  const { file, adapter } = await fixture(t);
  await writeFile(file, await readFile(new URL('./fixtures/claude-ft10.jsonl', import.meta.url)));
  const result = await adapter.read(file);
  assert.deepEqual(result.items.map(item => [item.role, item.text]), [
    ['user', 'Explain the fix'], ['user', 'Desktop question'], ['assistant', 'The **fix** is ready.'],
    ['tool', '🔧 Bash: Run the tests'], ['tool', '🔧 Read: src/bridge.js'], ['assistant', 'All done.'],
  ]);
  assert.equal(result.items[0].id, 'u1'); assert.equal(result.items[0].ts, '2026-11-02T00:00:00Z');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.deepEqual((await adapter.read(file, result.cursor)).items, []);
  assert.ok(claudeItems({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(200) } }] } })[0].text.endsWith('x'.repeat(60)));
});

test('fake /proc mapping requires exact comm and pane env, picks newest start time and reads exact session JSON only', async t => {
  const { root, adapter } = await fixture(t), proc = join(root, 'proc');
  async function process(pid, comm, pane, start) {
    const base = join(proc, String(pid)); await mkdir(base, { recursive: true });
    await writeFile(join(base, 'comm'), comm + '\n');
    await writeFile(join(base, 'environ'), `OTHER=x\0HERDR_PANE_ID=${pane}\0SECRET=never-log\0`);
    await writeFile(join(base, 'stat'), `${pid} (a command with spaces) S ${Array(18).fill('0').join(' ')} ${start} 0`);
  }
  await process(800, 'claude', 'pane', 10); await process(200, 'claude', 'pane', 20);
  await process(900, 'claude', 'pane-suffix', 30); await process(1000, 'sh', 'pane', 40);
  assert.equal(await paneProcess('pane', 'claude', proc), 200);
  assert.equal(await paneProcess('missing', 'claude', proc), null);
  const cwd = '/home/operator/my_repo.v2';
  assert.equal(projectDirectory(cwd), '-home-operator-my-repo-v2');
  const sessions = join(root, '.claude', 'sessions'), project = join(root, '.claude', 'projects', projectDirectory(cwd));
  await mkdir(sessions, { recursive: true }); await mkdir(project, { recursive: true });
  // A directory named *.key would fail if code tried to open it as a file.
  await mkdir(join(sessions, '200.key'));
  const session = id => writeFile(join(sessions, '200.json'), JSON.stringify({ pid: 200, cwd, sessionId: id, ignored: 'secret' }));
  await session('first'); const first = join(project, 'first.jsonl'); await writeFile(first, line('old'));
  assert.equal(await adapter.locate({ pane_id: 'pane' }), first);
  await session('second'); const second = join(project, 'second.jsonl'); await writeFile(second, line('new'));
  assert.equal(await adapter.locate({ pane_id: 'pane' }), second, '/clear or /resume re-locates the PID session');
  await session('../escape'); assert.equal(await adapter.locate({ pane_id: 'pane' }), null);
  await writeFile(join(sessions, '200.json'), JSON.stringify({ pid: 800, cwd, sessionId: 'first' }));
  assert.equal(await adapter.locate({ pane_id: 'pane' }), null);
  assert.equal(await new CodexTranscript().locate({ pane_id: 'pane' }), null);
});

test('byte cursor survives partial UTF-8, malformed lines, restart, truncation and replacement', async t => {
  const { file, adapter } = await fixture(t);
  await writeFile(file, line('old'));
  let { cursor } = await adapter.read(file, { atEnd: true });
  const bytes = Buffer.from(line('你好🙂'));
  const cut = bytes.indexOf(Buffer.from('🙂')) + 2;
  await appendFile(file, bytes.subarray(0, cut));
  let result = await adapter.read(file, cursor); assert.deepEqual(result.items, []);
  await appendFile(file, bytes.subarray(cut));
  result = await adapter.read(file, JSON.parse(JSON.stringify(result.cursor)));
  assert.equal(result.items[0].text, '你好🙂'); cursor = result.cursor;
  await appendFile(file, 'invalid JSON\n' + line('later'));
  result = await adapter.read(file, cursor); assert.equal(result.items[0].text, 'later');
  await writeFile(file, line('truncated'));
  result = await adapter.read(file, result.cursor); assert.equal(result.items[0].text, 'truncated');
  await rename(file, file + '.old'); await writeFile(file, line('rotated'));
  result = await adapter.read(file, result.cursor); assert.equal(result.items[0].text, 'rotated');
});

test('migration starts at byte EOF, skips a preexisting partial record, and bounds oversized records', async t => {
  const { file, adapter } = await fixture(t);
  await writeFile(file, line('history') + '{"partial":');
  let { cursor } = await adapter.read(file, { atEnd: true });
  await appendFile(file, 'true}\n' + line('fresh'));
  let result = await adapter.read(file, cursor); assert.deepEqual(result.items.map(x => x.text), ['fresh']);
  cursor = result.cursor;
  await appendFile(file, 'x'.repeat(1024 * 1024 + 50) + '\n' + line('bounded'));
  result = await adapter.read(file, cursor); assert.deepEqual(result.items, []);
  assert.equal(typeof result.cursor.anchor, 'string'); assert.ok(JSON.stringify(result.cursor).length < 300);
  result = await adapter.read(file, result.cursor); assert.equal(result.items[0].text, 'bounded');
});
