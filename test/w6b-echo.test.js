import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { legacyHarness as harness, message } from './helpers.js';
import { claudeItems } from '../src/transcripts/claude.js';
import { readJsonl } from '../src/transcripts/jsonl.js';

const sent = 'Please inspect the fixture project and explain the failing tests.';
const long = Array.from({ length: 60 }, (_, i) => `Line ${i}: inspect fixtures and preserve all existing changes.`).join('\r\n');
const desktop = h => h.feishu.calls.filter(c => c.content?.header?.title.content === '🧑 电脑端输入');
const record = (cli, text, time) => cli === 'claude' ? { type: 'user', uuid: 'fixture', timestamp: new Date(time).toISOString(), message: { content: [{ type: 'text', text }] } } :
  cli === 'codex' ? { type: 'event_msg', timestamp: new Date(time).toISOString(), payload: { type: 'user_message', message: text } } :
    { type: 'message', timestamp: new Date(time).toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } };
function project(cli, row) {
  if (cli === 'claude') return claudeItems(row);
  const text = cli === 'codex' ? row.payload.message : row.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return [{ role: 'user', text, ts: row.timestamp }];
}
async function setup(t, cli = 'claude') {
  let file;
  const adapter = { locate: async () => file, read: (path, cursor) => readJsonl(path, cursor?.atEnd ? null : cursor,
    row => project(cli, row), { end: Boolean(cursor?.atEnd) }) };
  const h = await harness(t, { adapters: { [cli]: adapter } });
  file = join(dirname(h.store.file), `${cli}-fixture.jsonl`); await writeFile(file, '');
  const pane = h.fake.create(); Object.assign(pane, { agent: cli, agent_status: 'working' });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  const b = () => h.bridge.store.forPane('w1:p1');
  return { h, pane, b, send: text => h.bridge.handle(message(text, `phone-${h.now()}`, b().topicId)),
    async append(text, time = h.now()) { await appendFile(file, JSON.stringify(record(cli, text, time)) + '\n'); h.advance(2000); await h.bridge.tick(); } };
}

for (const cli of ['claude', 'codex', 'pi']) for (const [label, text] of [['short', sent], ['multiline paste', long]]) {
  test(`${cli} ${label} transcript shape suppresses one normalized phone echo`, async t => {
    const s = await setup(t, cli); await s.send(text);
    const echo = label === 'short' ? '  ' + text + '  ' : `<pasted_content id="fixture-${cli}">\n[Pasted text #12 +60 lines]\n${text.replace(/\r\n/g, '\n').replace(/: /g, ':  ')}\n</pasted_content>`;
    await s.append(echo); assert.equal(desktop(s.h).length, 0);
    assert.deepEqual(s.b().sentInputs, []);
    await s.append(echo); assert.equal(desktop(s.h).length, 1, 'one delivery suppresses only one echo');
  });
}

test('the immediately following user turn containing delivered text is suppressed and survives restart', async t => {
  const s = await setup(t); await s.send(sent); await s.h.restart();
  await s.append(`Phone delivery context: ${sent}\nCLI appended context.`);
  assert.equal(desktop(s.h).length, 0); assert.deepEqual(s.b().sentInputs, []);
});

test('containment never suppresses a later desktop turn after unrelated desktop input, including restart', async t => {
  const s = await setup(t); await s.send(sent);
  await s.append('A different real desktop request.'); await s.h.restart();
  await s.append(`Desktop discussing an older request: ${sent}`);
  assert.equal(desktop(s.h).length, 2);
  await s.append(sent); assert.equal(desktop(s.h).length, 3, 'an intervening desktop turn also blocks an old normalized match');
});

for (const elapsed of [31000, 600001]) test(`desktop input resembling an older delivery after ${elapsed} ms is retained`, async t => {
  const s = await setup(t); await s.send(sent); s.h.advance(elapsed);
  await s.append(elapsed > 600000 ? sent : `Desktop quote: ${sent}`);
  assert.equal(desktop(s.h).length, 1);
});

test('a user transcript timestamp before delivery cannot consume a future phone input', async t => {
  const s = await setup(t); s.h.advance(10000); await s.send(sent);
  await s.append(sent, 0); assert.equal(desktop(s.h).length, 1);
});

test('a short word is not a containment match and a delivery to another terminal is not an echo', async t => {
  const s = await setup(t); await s.send('yes');
  await s.append('yes this is a separate desktop request'); assert.equal(desktop(s.h).length, 1);
  s.h.advance(1000); await s.send(sent);
  const b = s.b(); await s.h.bridge.store.update(b.chatId, b.topicId, { sentInputs: b.sentInputs.map(input => ({ ...input, terminalId: 'other-terminal' })) });
  await s.append(sent); assert.equal(desktop(s.h).length, 2);
});

test('a paste placeholder without delivered content is retained rather than guessed as an echo', async t => {
  const s = await setup(t); await s.send(sent);
  await s.append('[Pasted text #123 +60 lines]'); assert.equal(desktop(s.h).length, 1);
});

test('containment also handles a long paste without retaining the full input in matching state', async t => {
  const s = await setup(t), text = long.repeat(8); await s.send(text);
  assert.ok(s.b().sentInputs[0].prefix.length <= 64);
  assert.ok(!JSON.stringify(s.b().sentInputs).includes('Line 59'));
  await s.append(`CLI delivery context:\n${text}\nEnd context.`);
  assert.equal(desktop(s.h).length, 0); assert.deepEqual(s.b().sentInputs, []);
});
