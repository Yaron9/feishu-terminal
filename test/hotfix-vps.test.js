import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { detectMenu } from '../src/menus.js';
import { turnCard, screenCard } from '../src/render.js';
import { HcBackend } from '../src/backends/hc.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { legacyHarness as harness, message, pickerEvent } from './helpers.js';

const screen = 'Assistant is analyzing a synthetic request.\n\n1. First example?\n2. Second example?\n\n✶ Thinking… (12s · 3k tokens)\n────────────────────\n❯\n────────────────────\n  esc to interrupt';
const approval = 'Bash command\n\n  npm test\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel';
const callbacks = card => JSON.stringify(card).match(/"(?:value|behaviors)":/g) ?? [];
const bound = h => h.bridge.store.forPane('w1:p1');
const tap = (b, extra = {}) => ({ kind: 'button', eventId: randomUUID(), chatId: b.chatId, topicId: b.topicId,
  openId: 'ou_test', messageId: b.cardId, nonce: b.nonce, key: 'refresh', ...extra });

test('a synthetic terminal screen and numbered prose above a live prompt never become menu choices', () => {
  const prose = 'Please answer these questions?\n❯ 1. First example?\n  2. Second example?\n  3. Third example?\n  4. Fourth example?\n  5. Fifth example?';
  const prompt = '\n────────────────────\n❯\n────────────────────\n? for shortcuts';
  for (const text of [screen, prose, prose + prompt, approval + prompt, 'Questions?\n1. First?\n2. Second?']) {
    assert.equal(detectMenu(text).kind, null, text);
  }
  const backend = new HcBackend({});
  assert.equal(backend.status({ agent: 'claude', reported: false }, screen), 'working');
  const card = turnCard({ turn: { agent: 'Claude', adapter: 'claude', status: 'working', text: prose.replace('❯ ', ''), tools: '', toolCount: 0 }, screen });
  assert.equal(callbacks(card).length, 0);
  assert.match(JSON.stringify(card), /First example/);
  // Even menu-shaped text in a transcript cannot create a control surface.
  assert.equal(callbacks(turnCard({ turn: { status: 'working', text: approval } })).length, 0);
  assert.equal(callbacks(screenCard({ text: screen, status: 'working', agent: 'claude' })).length, 0);
});

test('only the live choice region is parsed, with status or explicit CLI menu evidence', () => {
  const prior = 'Earlier questions?\n1. First question?\n2. Second question?\n\n';
  assert.deepEqual(detectMenu(prior + approval), detectMenu(approval));
  const custom = 'Allow this action?\n❯ 1. Yes\n  2. No';
  assert.equal(detectMenu(custom, { status: 'working', cli: 'claude' }).kind, null);
  assert.equal(detectMenu(custom, { status: 'blocked' }).kind, 'numbered');
  assert.equal(detectMenu(custom, { status: 'waiting' }).kind, 'numbered');
  for (const cli of ['claude', 'codex', 'pi']) {
    assert.equal(detectMenu(approval, { status: 'idle', cli }).kind, 'numbered');
    assert.equal(detectMenu(approval + '\n❯ ', { status: 'blocked', cli }).kind, null);
  }
});

test('prose questions remain ordinary topic output and free text answers go to the terminal', async t => {
  const h = await harness(t), pane = h.fake.create();
  Object.assign(pane, { agent: 'claude', agent_status: 'working', text: screen, visible: screen });
  await h.bridge.handle(message('/t open w1:p1', 'open')); await h.bridge.tick();
  assert.equal(bound(h).menuCardId, undefined);
  await h.bridge.handle(message('The first example is ready.', 'answer', bound(h).topicId));
  assert.ok(h.fake.calls.some(c => c.method === 'agent.prompt' && c.params.text === 'The first example is ready.'));
});

test('a failed obsolete menu patch cannot block transcript output in the next tick, even if retirement still fails', async t => {
  const records = [], adapter = { locate: async () => 'fixture.jsonl', read: async (_path, cursor) => ({
    cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
  }) };
  const h = await harness(t, { adapters: { claude: adapter } }), pane = h.fake.create();
  Object.assign(pane, { agent: 'claude', agent_status: 'blocked', visible: approval, text: approval });
  await h.bridge.handle(message('/t open w1:p1', 'open')); await h.bridge.tick();
  const original = bound(h), patch = h.feishu.patch.bind(h.feishu);
  let offline = true;
  h.feishu.patch = async (id, card) => {
    if (id === original.menuCardId && offline) throw Object.assign(new Error('offline'), { code: 'network_error' });
    return patch(id, card);
  };
  pane.visible = approval.replace('npm test', 'npm run check');
  h.advance(2000); await h.bridge.tick();
  assert.ok(bound(h).pendingMenuCard);
  records.push({ role: 'assistant', text: 'Recovered transcript output' });
  Object.assign(pane, { agent_status: 'working', visible: screen, text: screen });
  h.bridge.state(bound(h)).dirty = true;
  h.advance(250); await h.bridge.tick();
  assert.equal(bound(h).turn.text, 'Recovered transcript output');
  assert.ok(bound(h).cardId);
  assert.ok(bound(h).outputBatch);
  offline = false;
  h.bridge.state(bound(h)).menuRetryAt = 0;
  h.advance(3000); await h.bridge.tick();
  h.advance(3000); await h.bridge.tick();
  assert.equal(bound(h).outputBatch, null);
  assert.equal(bound(h).pendingMenuCard, null);
  assert.equal(bound(h).menuCardId, null);
  assert.equal(bound(h).generation, original.generation);
  assert.ok(h.feishu.calls.some(c => c.type === 'patch' && c.id === original.menuCardId && /Recovered transcript output/.test(JSON.stringify(c.card))));
});

test('a recovered transport retires a pending menu within one tick without waiting for its old retry timer', async t => {
  const h = await harness(t), pane = h.fake.create();
  Object.assign(pane, { agent: 'claude', agent_status: 'blocked', visible: approval, text: approval });
  await h.bridge.handle(message('/t open w1:p1', 'open')); await h.bridge.tick();
  const original = bound(h), patch = h.feishu.patch.bind(h.feishu);
  h.feishu.patch = async () => { throw Object.assign(new Error('offline'), { code: 'network_error' }); };
  pane.visible = approval.replace('npm test', 'npm run check');
  h.advance(2000); await h.bridge.tick();
  assert.ok(bound(h).pendingMenuCard);
  h.bridge.state(bound(h)).menuRetryAt = h.now() + 30000;
  h.bridge.state(bound(h)).cardRetryAt = h.now() + 30000;
  h.feishu.patch = patch;
  Object.assign(pane, { agent_status: 'working', visible: screen, text: screen });
  h.bridge.state(bound(h)).dirty = true;
  h.advance(250); await h.bridge.tick();
  assert.equal(bound(h).pendingMenuCard, null);
  assert.equal(bound(h).menuCardId, null);
  assert.equal(bound(h).generation, original.generation);
  assert.ok(bound(h).cardId);
  assert.ok(h.feishu.calls.some(c => c.type === 'reply' && c.id === bound(h).cardId));
});

test('status and turn cards have no age expiry; spent nonces stay spent after replay and restart', async t => {
  for (const withTurns of [false, true]) {
    const records = [], adapter = { locate: async () => 'fixture.jsonl', read: async (_path, cursor) => ({
      cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
    }) };
    const h = await harness(t, withTurns ? { adapters: { claude: adapter } } : {}), pane = h.fake.create();
    Object.assign(pane, { agent: 'claude', agent_status: 'blocked', visible: 'Allow reading fixture.txt? [y/n]', text: 'Approval' });
    await h.bridge.handle(message('/t open w1:p1', 'open'));
    if (withTurns) records.push({ role: 'assistant', text: 'Need approval' });
    await h.bridge.tick();
    const old = bound(h), event = tap(old, { key: 'y' });
    h.advance(86400000); await h.restart(); await h.bridge.handle(event);
    const writes = () => h.fake.calls.filter(c => c.method === 'pane.send_keys').length;
    assert.equal(writes(), 1);
    await h.bridge.handle({ ...event, eventId: randomUUID() });
    await h.restart(); await h.bridge.handle({ ...event, eventId: randomUUID() });
    assert.equal(writes(), 1);
    assert.ok(h.feishu.calls.some(c => c.type === 'patch' && c.id === old.cardId));
  }
});

test('topic pickers survive maintenance and management history pressure; stale taps patch without executing', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  await h.bridge.handle(message('/t close', 'close', bound(h).topicId));
  const event = pickerEvent(h, 'unbind'), card = h.bridge.store.actionCard(event.messageId);
  await h.bridge.store.transaction(data => {
    for (let i = 0; i < 520; i++) data.actionCards.push({ messageId: `management-${i}`, nonce: `n-${i}` });
  });
  h.advance(14 * 86400000); await h.bridge.store.maintain(h.now()); await h.restart();
  assert.deepEqual(h.bridge.store.actionCard(event.messageId), card);
  await h.bridge.handle(event); assert.equal(h.bridge.store.list().length, 0);
  await h.bridge.handle({ ...event, eventId: randomUUID() });
  assert.equal(h.bridge.store.list().length, 0);
  assert.ok(h.feishu.calls.some(c => c.type === 'patch' && c.id === event.messageId));
});

test('a synthetic binding migrates without losing pending payloads, cursors, timestamps or menu state', async t => {
  const dir = await mkdtemp(new URL('../.test-hotfix-state-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binding = { chatId: 'oc_fixture', topicId: 'om_fixture', paneId: 'hc:t1',
    identity: { terminalId: 'fixture-terminal' }, generation: 'fixture-generation', nonce: 'fixture-nonce',
    cli: 'claude', sessionId: 'fixture-session', claudeSessionId: 'fixture-session',
    topicRoot: { type: 'text', text: 'Synthetic topic', createdAt: 1700000000000 },
    transcript: { adapter: 'claude', path: '/tmp/fixture.jsonl', cursor: { offset: 42, atEnd: false,
      background: { finished: [{ id: 'job1', description: 'Synthetic job', status: 'completed' }] } } },
    pendingCard: { uuid: 'fixture-uuid', card: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Synthetic output' }] } } },
    lastTranscript: 'Synthetic prior output', menuSignature: 'synthetic-menu' };
  for (const version of [1, 2]) {
    const file = join(dir, `v${version}.json`), data = { version, bindings: [binding], seen: ['event:existing'] };
    await writeFile(file, JSON.stringify(data));
    const store = await new Store(file).load(), saved = store.list()[0];
    for (const [key, value] of Object.entries(binding)) assert.deepEqual(saved[key], value, key);
    assert.equal(saved.sessionId, version === 1 ? binding.claudeSessionId : binding.sessionId);
    await store.maintain(Date.now());
    assert.deepEqual((await new Store(file).load()).list(), store.list());
    if (version === 1) assert.deepEqual(JSON.parse(await readFile(file + '.v1.bak', 'utf8')), data);
  }
});

test('the standalone CLI starts with a synthetic legacy config shape and safe defaults', async t => {
  const dir = await mkdtemp(new URL('../.test-hotfix-cli-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { chatIds: ['oc_fixture'], operatorOpenIds: ['ou_fixture'], defaultCwd: dir,
    stateFile: join(dir, 'bridge.json'), auditFile: join(dir, 'audit.jsonl'), backends: ['hc'], newTerminalBackend: 'hc' };
  Object.assign(config, { defaultCwd: dir, stateFile: join(dir, 'bridge.json'), auditFile: join(dir, 'audit.jsonl') });
  const file = join(dir, 'config.json'); await writeFile(file, JSON.stringify(config));
  const env = { ...process.env, FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture', FEISHU_TERMINAL_CONFIG: file,
    FEISHU_TERMINAL_ENV: join(dir, 'absent.env') };
  const loaded = await loadConfig(env);
  assert.equal(loaded.idleMinutes, 10); assert.equal(loaded.sessionFollow, 'newest');
  assert.deepEqual(loaded.backends, ['hc']); assert.equal(loaded.newTerminalBackend, 'hc');
  const child = spawn(process.execPath, ['--import', new URL('./fixtures/hotfix-startup.mjs', import.meta.url).href,
    fileURLToPath(new URL('../bin/feishu-terminal.js', import.meta.url))],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI startup timed out: ' + output)); }, 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exit, 0, output); assert.match(output, /feishu-terminal running/);
});
