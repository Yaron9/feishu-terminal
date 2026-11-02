import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeTranscript } from '../src/transcripts/claude.js';
import { harness, message } from './helpers.js';

const user = text => JSON.stringify({ type: 'user', uuid: text, message: { content: text } }) + '\n';
const assistant = text => JSON.stringify({ type: 'assistant', uuid: text, message: { content: [
  { type: 'text', text }, { type: 'tool_use', name: 'Bash', input: { description: 'Check tests' } },
] } }) + '\n';
const conversation = h => h.feishu.calls.filter(c => c.type === 'reply' && c.content?.schema === '2.0');

async function setup(t, history = user('old history')) {
  const root = await mkdtemp(new URL('../.test-ft10-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  let file = join(root, 'first.jsonl'); await writeFile(file, history);
  const reader = new ClaudeTranscript();
  const adapter = { locate: async () => file, read: (...args) => reader.read(...args) };
  const h = await harness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); pane.agent = 'claude'; pane.agent_status = 'working';
  pane.scroll = { viewport_rows: 6, max_offset_from_bottom: 100 };
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const topic = h.store.forPane(pane.pane_id).topicId;
  return { h, pane, topic, adapter, file, async rotate(history = '') {
    file = join(root, 'second.jsonl'); await writeFile(file, history); return file;
  } };
}

test('Claude cards distinguish desktop input, assistant and tools; Feishu input is consumed once, including after restart', async t => {
  const { h, file, topic } = await setup(t);
  await h.bridge.handle(message('phone question', 'phone', topic));
  await appendFile(file, user('phone question') + assistant('Answer from Claude') + user('desktop question') + user('phone question'));
  await h.bridge.tick();
  const cards = conversation(h);
  assert.deepEqual(cards.map(c => c.content.header.title.content), ['🤖 Claude', '🧑 电脑端输入', '🧑 电脑端输入']);
  assert.equal(cards[0].content.body.elements[1].header.title.content, '🔧 工具调用 (1)');
  assert.equal(cards[0].content.body.elements[1].expanded, false);
  assert.ok(!JSON.stringify(h.feishu.calls).includes('old history'));
  const binding = h.bridge.store.forPane('w1:p1'); assert.deepEqual(binding.sentInputs, []);
  assert.equal(binding.transcript.cursor.offset, Buffer.byteLength(user('old history') + user('phone question') + assistant('Answer from Claude') + user('desktop question') + user('phone question')));
  await h.bridge.handle(message('phone after restart', 'phone2', topic));
  await h.restart(); await appendFile(file, user('phone after restart') + assistant('After restart'));
  await h.bridge.tick();
  assert.equal(conversation(h).length, 4);
  assert.ok(!JSON.stringify(h.audits).includes('phone question'));
  assert.ok(!JSON.stringify(h.audits).includes('Answer from Claude'));
  assert.ok(h.fake.calls.filter(c => c.method === 'pane.read').every(c => c.params.source === 'visible'));
});

test('existing bindings migrate at current EOF, while a saved cursor catches up on restart', async t => {
  const { h, file } = await setup(t);
  await h.bridge.store.update('oc_test', h.bridge.store.forPane('w1:p1').topicId, { transcript: null });
  await appendFile(file, assistant('before upgrade'));
  await h.restart(); await h.bridge.tick(); assert.equal(conversation(h).length, 0);
  await appendFile(file, assistant('missed during downtime'));
  await h.restart(); await h.bridge.tick();
  assert.equal(conversation(h).length, 1);
  assert.match(JSON.stringify(conversation(h)[0].content), /missed during downtime/);
});

test('session changes re-locate and baseline resumed history, then deliver fresh turns', async t => {
  const s = await setup(t), { h } = s;
  await appendFile(s.file, assistant('first session answer')); await h.bridge.tick();
  const next = await s.rotate(user('resumed old question') + assistant('resumed old answer'));
  h.advance(1000); await h.bridge.tick(); assert.equal(conversation(h).length, 1);
  await appendFile(next, assistant('fresh answer')); h.advance(1000); await h.bridge.tick();
  assert.equal(conversation(h).length, 2); assert.match(JSON.stringify(conversation(h)[1].content), /fresh answer/);
  assert.equal(h.bridge.store.forPane('w1:p1').transcript.path, next);
});

test('ambiguous transcript card send retries the same card and UUID after restart, then advances the byte cursor', async t => {
  const { h, file, topic } = await setup(t);
  await h.bridge.handle(message('phone', 'phone', topic));
  const baseline = h.bridge.store.forPane('w1:p1').transcript.cursor.offset;
  await appendFile(file, user('phone') + assistant('durable reply'));
  const reply = h.feishu.reply.bind(h.feishu); let pending;
  h.feishu.reply = async (topic, card, type, uuid) => {
    if (card?.header?.title.content === '🤖 Claude') { pending = { card, uuid }; throw new Error('secret response lost'); }
    return reply(topic, card, type, uuid);
  };
  await h.bridge.tick();
  assert.equal(h.bridge.store.forPane('w1:p1').transcript.cursor.offset, baseline);
  assert.ok(h.bridge.store.forPane('w1:p1').outputBatch);
  h.feishu.reply = async (topic, card, type, uuid) => {
    if (card?.header?.title.content === '🤖 Claude') { assert.equal(uuid, pending.uuid); assert.deepEqual(card, pending.card); }
    return reply(topic, card, type, uuid);
  };
  await appendFile(file, user('desktop later'));
  await h.restart(); await h.bridge.tick(); h.advance(1000); await h.bridge.tick();
  assert.equal(conversation(h).length, 2);
  assert.deepEqual(h.bridge.store.forPane('w1:p1').sentInputs, []);
  assert.equal(h.bridge.store.forPane('w1:p1').outputBatch, null);
  assert.ok(!JSON.stringify(h.errors).includes('secret'));
});

test('raw Feishu input is matched, a rejected blocked prompt does not suppress desktop input, and expired matches do not suppress it', async t => {
  const { h, file, topic, pane } = await setup(t);
  await h.bridge.handle(message('/t raw raw text', 'raw', topic));
  await appendFile(file, user('raw text')); await h.bridge.tick(); assert.equal(conversation(h).length, 0);
  pane.agent_status = 'blocked';
  await h.bridge.handle(message('blocked question', 'blocked', topic));
  await appendFile(file, user('blocked question')); h.advance(1000); await h.bridge.tick();
  assert.equal(conversation(h).length, 1);
  pane.agent_status = 'working'; await h.bridge.handle(message('expired question', 'expired', topic));
  h.advance(600001); await appendFile(file, user('expired question')); await h.bridge.tick();
  assert.equal(conversation(h).length, 2);
});

test('transcript read crossing pane reuse freezes the binding and drops all new content', async t => {
  const { h, file, pane, adapter } = await setup(t);
  await appendFile(file, assistant('PRIVATE REUSED OUTPUT'));
  const read = adapter.read; adapter.read = async (...args) => {
    const result = await read(...args); pane.terminal_id = 'reused'; return result;
  };
  await h.bridge.tick();
  assert.equal(h.bridge.store.forPane('w1:p1').frozen, true);
  assert.ok(!JSON.stringify(h.feishu.calls).includes('PRIVATE REUSED OUTPUT'));
  assert.ok(!JSON.stringify(h.bridge.store.list()).includes('PRIVATE REUSED OUTPUT'));
});

test('a transient transcript read failure uses bounded fallback and retries locally without logging source content', async t => {
  const { h, file, pane, adapter } = await setup(t);
  await h.bridge.tick();
  const read = adapter.read;
  adapter.read = async () => { throw new Error('PRIVATE SOURCE DETAIL'); };
  pane.agent_status = 'idle'; h.fake.output(pane.pane_id, 'Fallback answer');
  await h.bridge.tick(); h.advance(1500); await h.bridge.tick();
  assert.ok(conversation(h).some(c => JSON.stringify(c.content).includes('Fallback answer')));
  assert.ok(h.fake.calls.filter(c => c.method === 'pane.read').every(c => c.params.lines <= 106));
  assert.ok(h.errors.includes('transcript_unavailable'));
  assert.ok(!JSON.stringify(h.errors).includes('PRIVATE SOURCE DETAIL'));
  adapter.read = read;
  await appendFile(file, assistant('Recovered transcript')); h.advance(5000); await h.bridge.tick();
  assert.ok(conversation(h).some(c => JSON.stringify(c.content).includes('Recovered transcript')));
});

test('fallback shell uses one compact output card and /t screen returns the entire current viewport in bounded cards', async t => {
  const h = await harness(t); await h.bridge.handle(message('pwd'));
  h.fake.output('w1:p1', '$ ' + Array.from({ length: 90 }, (_, i) => `line ${i}`).join('\n') + '\n❯ \n✻ Worked for 3s\n╰─────╯');
  await h.bridge.tick(); h.advance(1500); await h.bridge.tick();
  const output = conversation(h).filter(c => c.content.header.title.content === '💻 输出');
  assert.equal(output.length, 1);
  assert.match(output[0].content.body.elements[0].content, /line 30/);
  assert.ok(!output[0].content.body.elements[0].content.includes('line 29\n'));
  assert.ok(!output[0].content.body.elements[0].content.includes('Worked for'));
  const full = '<&`🙂'.repeat(2000);
  h.fake.panes.get('w1:p1').visible = full;
  await h.bridge.handle(message('/t screen', 'screen', 'm1'));
  const screens = conversation(h).filter(c => c.content.header.title.content === '💻 当前屏幕');
  const decoded = screens.map(c => c.content.body.elements[0].content.slice(8, -4)
    .replace(/`\u200b/g, '`').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('');
  assert.equal(decoded, full);
  assert.ok(screens.every(c => Buffer.byteLength(JSON.stringify(c.content)) < 28000));
});
