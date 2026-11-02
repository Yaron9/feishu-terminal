import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { extractBackgroundTail, readBackgroundOutput, refreshBackgroundTails } from '../src/transcripts/background.js';
import { turnCard, screenCard, outputCard, assistantCard } from '../src/render.js';
import { planTurnTip, TIP_INTERVAL, WELCOME_TIP, CLIPPED_TIP, RECOVERY_TIP, ROTATING_TIPS } from '../src/card-tips.js';
import { harness, message } from './helpers.js';

const text = card => JSON.stringify(card);
const turn = (patch = {}) => ({ id: 'one', agent: 'Claude', text: 'Answer', settled: true, status: 'idle', ...patch });
async function outputFixture(t) {
  const root = `/tmp/claude-${randomInt(1000000, 9999999)}`;
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: root + '/task.output' };
}

test('tail selects latest nonempty line, strips ANSI/control/binary garbage and bounds display columns', () => {
  assert.equal(extractBackgroundTail('old\n\x1b[31m# pass 288\x1b[0m\x07\n \n'), '# pass 288');
  assert.equal(extractBackgroundTail('\n \n\x00\x7f\ufffd'), '');
  assert.equal(extractBackgroundTail('x'.repeat(100)), 'x'.repeat(80));
  assert.equal(extractBackgroundTail('中'.repeat(100)), '中'.repeat(40));
  assert.equal(extractBackgroundTail('🙂'.repeat(100)), '🙂'.repeat(40));
  assert.equal(extractBackgroundTail('🇨🇳'.repeat(100)), '🇨🇳'.repeat(40));
  assert.equal(extractBackgroundTail('e\u0301'.repeat(100)), 'e\u0301'.repeat(80));
  assert.equal(extractBackgroundTail(Buffer.from([0, 255, 27, 91, 51, 49, 109, 111, 107, 7]).toString()), 'ok');
});

test('tracked output reads at most final 4 KiB and rejects traversal, wrong roots and nonregular files', async t => {
  const f = await outputFixture(t);
  await writeFile(f.path, 'SECRET'.repeat(2000) + '\n' + 'z'.repeat(4090) + '\nend\n');
  assert.equal(await readBackgroundOutput({ outputFile: f.path }), 'end');
  await writeFile(f.path, 'a'.repeat(5000));
  assert.equal(await readBackgroundOutput({ outputFile: f.path }), 'a'.repeat(80));
  await writeFile(f.path, 'must not be read\n' + '\n'.repeat(4096));
  assert.equal(await readBackgroundOutput({ outputFile: f.path }), '');
  for (const path of [null, '/etc/passwd', '/tmp/claude-abc/file', f.root + '/../escape', f.root + '/./task.output', f.root + '//task.output', f.root + '/back\\slash', f.root + '/']) {
    await assert.rejects(readBackgroundOutput({ outputFile: path }), /unsafe_background_path/);
  }
  await mkdir(f.root + '/directory');
  await assert.rejects(readBackgroundOutput({ outputFile: f.root + '/directory' }), /unsafe_background_path/);
  await writeFile(f.path, Buffer.from([0, 255, 254, 10, 111, 107, 10]));
  assert.equal(await readBackgroundOutput({ outputFile: f.path }), 'ok');
});

test('output validation rejects symlink file, directory and root escapes', async t => {
  const f = await outputFixture(t), outside = await mkdtemp(resolve('/tmp/ft27-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(posix.join(outside.replaceAll('\\', '/'), 'secret'), 'private');
  await symlink(resolve(outside, 'secret'), f.root + '/escape', 'file');
  await symlink(outside, f.root + '/subdir', process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of [f.root + '/escape', f.root + '/subdir/secret']) await assert.rejects(readBackgroundOutput({ outputFile: path }), /unsafe_background_path/);
  const linkedRoot = f.root + '1';
  await symlink(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(linkedRoot, { recursive: true, force: true }));
  await assert.rejects(readBackgroundOutput({ outputFile: linkedRoot + '/secret' }), /unsafe_background_path/);
});

test('tail cache attempts reads only once per card per 10 seconds, including failures and restart', async () => {
  let reads = 0;
  const bg = { running: [{ id: 'a', outputFile: '/tmp/claude-1/a' }], finished: [] };
  const read = async () => { reads++; return 'line'; };
  let cache = await refreshBackgroundTails(bg, null, 'card', 0, read);
  assert.equal(bg.running[0].tail, 'line');
  cache = await refreshBackgroundTails(bg, JSON.parse(JSON.stringify(cache)), 'card', 9999, read);
  assert.equal(reads, 1);
  cache = await refreshBackgroundTails(bg, cache, 'card', 10000, read);
  assert.equal(reads, 2);
  await refreshBackgroundTails(bg, cache, 'new-card', 10001, read);
  assert.equal(reads, 3);
  cache = await refreshBackgroundTails(bg, null, 'card', 0, async () => { reads++; throw new Error('missing'); });
  assert.equal(bg.running[0].tail, '');
  await refreshBackgroundTails(bg, cache, 'card', 9999, read);
  assert.equal(reads, 4);
});

test('running tails are grey and escaped; empty output and finished tasks have no tail or output button', () => {
  const bg = { running: [{ description: 'Build', minutes: 15, tail: '<at> # pass 288' }], finished: [] };
  assert.match(text(turnCard({ turn: turn({ background: bg }) })), /grey.*└ &lt;at&gt; # pass 288/);
  bg.running[0].tail = '';
  assert.doesNotMatch(text(turnCard({ turn: turn({ background: bg }) })), /└|background-output/);
  bg.finished = [{ ...bg.running.pop(), tail: 'secret', status: 'completed' }];
  assert.doesNotMatch(text(turnCard({ turn: turn({ background: bg }) })), /└|secret/);
});

test('cards have no fixed footer or commands by default; clipping adds a single grey contextual tip', () => {
  const cards = [turnCard({ turn: turn() }), screenCard({ text: 'ok', status: 'idle' }), outputCard('ok'), assistantCard('ok')];
  for (const card of cards) assert.doesNotMatch(text(card), /\/t |在本话题直接回复/);
  const clipped = [turnCard({ turn: turn({ truncated: true }) }), turnCard({ turn: turn({ toolsTruncated: true }) }),
    screenCard({ text: Array(11).fill('line').join('\n') }), screenCard({ text: 'x'.repeat(121) }),
    outputCard(Array(61).fill('line').join('\n')), assistantCard('x'.repeat(1501))];
  for (const card of clipped) {
    assert.equal(text(card).split(CLIPPED_TIP).length - 1, 1);
    assert.match(text(card), /grey.*完整内容/);
  }
});

test('blocked/menu cards show only their button explanation; errors/frozen states show recovery', () => {
  for (const card of [turnCard({ turn: turn({ settled: false, status: 'blocked', truncated: true }), tip: WELCOME_TIP }),
    screenCard({ text: 'Allow?', status: 'blocked' })]) {
    assert.match(text(card), /点按钮等于在终端里按对应的键/);
    assert.doesNotMatch(text(card), /\/t |直接在本话题/);
  }
  const menu = turnCard({ turn: turn({ text: 'Allow?\n1. Yes\n2. No' }), tip: WELCOME_TIP });
  assert.match(text(menu), /点选项按钮即可选择/);
  assert.doesNotMatch(text(menu), /\/t /);
  for (const status of ['error', 'failed', 'frozen']) {
    for (const card of [turnCard({ turn: turn({ status, truncated: true }), tip: WELCOME_TIP }), screenCard({ text: 'bad', status })]) {
      assert.ok(text(card).includes(RECOVERY_TIP));
      assert.ok(!text(card).includes(CLIPPED_TIP));
    }
  }
});

test('welcome belongs only to first turn of a new topic; rotation is settled only and persisted across restart', async t => {
  const h = await harness(t);
  await h.bridge.handle(message('claude'));
  let b = h.bridge.store.list()[0];
  let planned = planTurnTip(b, turn({ settled: false }), 0);
  assert.equal(planned.text, WELCOME_TIP);
  await h.bridge.store.update(b.chatId, b.topicId, planned.patch);
  await h.restart(); b = h.bridge.store.list()[0];
  assert.equal(planTurnTip(b, turn(), 1).text, WELCOME_TIP);
  assert.equal(planTurnTip(b, turn({ id: 'two', settled: false }), TIP_INTERVAL).text, '');
  assert.equal(planTurnTip(b, turn({ id: 'two' }), TIP_INTERVAL - 1).text, '');
  planned = planTurnTip(b, turn({ id: 'two' }), TIP_INTERVAL);
  assert.equal(planned.text, ROTATING_TIPS[0]);
  await h.bridge.store.update(b.chatId, b.topicId, planned.patch);
  await h.restart(); b = h.bridge.store.list()[0];
  assert.equal(planTurnTip(b, turn({ id: 'three' }), TIP_INTERVAL + 1).text, '');
  assert.equal(planTurnTip(b, turn({ id: 'three' }), TIP_INTERVAL * 2).text, ROTATING_TIPS[1]);
  assert.equal(planTurnTip({ welcomePending: true }, turn(), 0, false).text, '');
});

test('live tail patches only on changed lines after 10 seconds and still respects the 2 second card throttle', async t => {
  const f = await outputFixture(t); await writeFile(f.path, 'first\n');
  const records = [], bg = { running: [], finished: [], pending: {} };
  const adapter = { locate: async () => 'fixture', read: async (_, cursor) => ({ items: cursor.atEnd ? [] : records.slice(cursor.offset),
    cursor: { offset: records.length, background: structuredClone(bg) } }) };
  const h = await harness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); Object.assign(pane, { agent: 'claude', agent_status: 'working' });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  records.push({ role: 'assistant', text: 'Answer' });
  bg.running.push({ id: 'bg', description: 'Build', outputFile: f.path, startedAt: new Date(0).toISOString() });
  const binding = () => h.bridge.store.forPane('w1:p1');
  const poll = async ms => { h.advance(ms); h.bridge.state(binding()).dirty = true; await h.bridge.tick(); };
  await poll(0); const id = binding().cardId;
  const patches = () => h.feishu.calls.filter(c => c.type === 'patch' && c.id === id);
  await poll(2000); const before = patches().length;
  await writeFile(f.path, 'second\n');
  await poll(7999); assert.equal(patches().length, before);
  await poll(1); assert.equal(patches().length, before + 1);
  assert.match(text(patches().at(-1).card), /└ second/);
  await poll(10000); assert.equal(patches().length, before + 1);
  records.push({ role: 'assistant', text: 'more' });
  await poll(9000); const latest = patches().at(-1).time;
  await writeFile(f.path, 'third\n'); await poll(1000);
  assert.equal(patches().at(-1).time, latest);
  await poll(1000); assert.match(text(patches().at(-1).card), /└ third/);
  assert.ok(patches().every((c, i, a) => !i || c.time - a[i - 1].time >= 2000));
});

test('publication shows one welcome, suppresses working rotation, and persists the settled rotation reservation with retries', async t => {
  const records = [];
  const adapter = { locate: async () => 'fixture', read: async (_, cursor) => ({ items: cursor.atEnd ? [] : records.slice(cursor.offset), cursor: { offset: records.length } }) };
  const h = await harness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); Object.assign(pane, { agent: 'claude', agent_status: 'working' });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const b = () => h.bridge.store.forPane('w1:p1');
  const poll = async ms => { h.advance(ms); h.bridge.state(b()).dirty = true; await h.bridge.tick(); };
  records.push({ role: 'assistant', text: 'First answer' }); await poll(0);
  const firstId = b().cardId;
  assert.ok(text(h.feishu.calls.find(c => c.type === 'reply' && c.id === firstId).content).includes(WELCOME_TIP));
  pane.agent_status = 'done'; await poll(2000);
  records.push({ role: 'user', text: 'Second' }, { role: 'assistant', text: 'Second answer' });
  pane.agent_status = 'working'; await poll(TIP_INTERVAL); await poll(2000);
  const secondId = b().cardId;
  assert.notEqual(firstId, secondId);
  assert.doesNotMatch(text(h.feishu.calls.find(c => c.type === 'reply' && c.id === secondId).content), /\/t /);
  const patch = h.feishu.patch.bind(h.feishu);
  let fail = true;
  h.feishu.patch = async (id, card) => { if (id === secondId && fail) throw new Error('offline'); return patch(id, card); };
  pane.agent_status = 'done'; await poll(2000);
  assert.equal(b().tipText, ROTATING_TIPS[0]);
  assert.ok(text(b().pendingCard.card).includes(ROTATING_TIPS[0]));
  const tipTime = b().lastTipAt;
  fail = false; await h.restart(); await poll(2000);
  assert.equal(b().lastTipAt, tipTime);
  assert.equal(b().tipIndex, 1);
  assert.ok(text(h.feishu.calls.filter(c => c.type === 'patch' && c.id === secondId).at(-1).card).includes(ROTATING_TIPS[0]));
  records.push({ role: 'user', text: 'Third' }, { role: 'assistant', text: 'Third answer' });
  pane.agent_status = 'working'; await poll(2000); await poll(2000);
  pane.agent_status = 'done'; await poll(2000);
  const thirdId = b().cardId;
  const third = h.feishu.calls.filter(c => c.id === thirdId).at(-1);
  assert.doesNotMatch(text(third.card ?? third.content), /\/t /);
  const oldTopic = b().topicId;
  await h.bridge.move(message('/t move', 'move', oldTopic), 'w1:p1');
  assert.notEqual(b().topicId, oldTopic);
  const movedCard = h.feishu.calls.findLast(c => c.type === 'reply' && c.topicId === b().topicId && c.msgType === 'interactive');
  assert.ok(text(movedCard.content).includes(WELCOME_TIP));
});
