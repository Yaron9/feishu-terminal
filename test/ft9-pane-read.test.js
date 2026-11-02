import test from 'node:test';
import assert from 'node:assert/strict';
import { HerdrClient } from '../src/herdr-client.js';
import { readPane } from '../src/pane-read.js';
import { fakeHerdr, harness, message, pickerEvent, outputReplies } from './helpers.js';

const reads = fake => fake.calls.filter(c => c.method === 'pane.read');

async function reader(t) {
  const fake = await fakeHerdr(), pane = fake.create();
  const client = new HerdrClient({ endpoint: fake.endpoint, timeoutMs: 1000 });
  t.after(async () => { client.close(); await fake.close(); });
  return { fake, pane, client };
}

test('zero-scrollback panes use only visible reads, including the measured 66/67/100/2000 line cases', async t => {
  const { fake, pane, client } = await reader(t);
  pane.scroll = { viewport_rows: 66, max_offset_from_bottom: 0 };
  for (const source of ['visible', 'recent', 'recent_unwrapped']) {
    for (const lines of [1, 40, 60, 66, 67, 100, 2000]) {
      await readPane(client, pane.pane_id, { source, lines });
      assert.deepEqual(reads(fake).at(-1).params, {
        pane_id: pane.pane_id, source: 'visible', lines: Math.min(lines, 66),
      });
    }
  }
});

test('shell history reads retain recent sources within viewport plus scrollback and cap visible separately', async t => {
  const { fake, pane, client } = await reader(t);
  pane.scroll = { viewport_rows: 12, max_offset_from_bottom: 8, offset_from_bottom: 3 };
  pane.text = 'history\ncurrent'; pane.visible = 'current';
  for (const source of ['recent', 'recent_unwrapped']) {
    for (const lines of [1, 19, 20, 21, 80, 2000]) {
      assert.equal((await readPane(client, pane.pane_id, { source, lines })).read.text, pane.text);
      assert.deepEqual(reads(fake).at(-1).params, {
        pane_id: pane.pane_id, source, lines: Math.min(lines, 20),
      });
    }
  }
  assert.equal((await readPane(client, pane.pane_id, { source: 'visible', lines: 40 })).read.text, 'current');
  assert.equal(reads(fake).at(-1).params.lines, 12);
  assert.equal(pane.scroll.offset_from_bottom, 3);
});

test('each read gets fresh limits after resizing, history loss, or switching to an alternate screen', async t => {
  const { fake, pane, client } = await reader(t);
  for (const [rows, offset] of [[40, 3000], [12, 4], [6, 0], [20, 5]]) {
    pane.scroll = { viewport_rows: rows, max_offset_from_bottom: offset };
    const before = fake.calls.length;
    await readPane(client, pane.pane_id);
    assert.deepEqual(fake.calls.slice(before).map(c => c.method), ['pane.get', 'pane.read']);
    assert.equal(reads(fake).at(-1).params.lines, Math.min(2000, rows + offset));
    assert.equal(reads(fake).at(-1).params.source, offset ? 'recent_unwrapped' : 'visible');
  }
});

test('missing or invalid scroll metadata fails without issuing a pane read', async t => {
  const { fake, pane, client } = await reader(t);
  for (const scroll of [undefined, {}, { viewport_rows: 40 },
    ...[0, -1, 1.5, '40', null].map(viewport_rows => ({ viewport_rows, max_offset_from_bottom: 0 })),
    ...[-1, 1.5, '0', null].map(max_offset_from_bottom => ({ viewport_rows: 40, max_offset_from_bottom })),
    { viewport_rows: Number.MAX_SAFE_INTEGER, max_offset_from_bottom: 1 }]) {
    pane.scroll = scroll;
    await assert.rejects(readPane(client, pane.pane_id), { code: 'invalid_scroll' });
  }
  fake.fail('pane.get', 'unavailable');
  await assert.rejects(readPane(client, pane.pane_id), { code: 'unavailable' });
  await assert.rejects(readPane(client, 'missing'), { code: 'pane_not_found' });
  assert.equal(reads(fake).length, 0);
});

test('invalid read options cannot reach herdr or rely on an unbounded default', async t => {
  const { fake, pane, client } = await reader(t);
  for (const options of [{ source: 'recent-unwrapped' }, ...[0, -1, 1.5, Infinity, '40'].map(lines => ({ lines }))])
    await assert.rejects(readPane(client, pane.pane_id, options), TypeError);
  assert.equal(fake.calls.length, 0);
});

for (const offset of [0, 4]) {
  test(`bridge baseline, refresh, settle flush, picker, callbacks, needs_check and restart stay bounded (scrollback=${offset})`, async t => {
    const h = await harness(t), pane = h.fake.create();
    pane.scroll = { viewport_rows: 6, max_offset_from_bottom: offset };
    if (!offset) { pane.agent = 'claude'; pane.agent_status = 'idle'; }
    await h.bridge.handle(message('/t open w1:p1', 'open'));
    const topic = h.store.forPane(pane.pane_id).topicId;
    const step = async (label, action) => {
      const before = reads(h.fake).length;
      await action();
      assert.ok(reads(h.fake).length > before, `${label} must exercise a read`);
      assert.ok(!h.bridge.store.forPane(pane.pane_id).frozen, label);
    };
    await step('input baseline', () => h.bridge.handle(message('hello', 'input', topic)));
    await h.subscribed();
    await step('poll refresh', () => h.bridge.tick());
    h.fake.output(pane.pane_id, '$ \nfirst answer');
    await h.drain(); h.advance(1000);
    await step('changed screen', () => h.bridge.tick());
    h.advance(1500);
    await step('settle flush', () => h.bridge.tick());
    assert.ok(outputReplies(h.feishu).some(c => c.content === '\nfirst answer'));
    h.fake.output(pane.pane_id, 'first answer\nsecond answer');
    await h.drain(); h.advance(1000); await h.bridge.tick();
    h.advance(1500); await h.bridge.tick();
    assert.ok(outputReplies(h.feishu).some(c => c.content === '\nsecond answer'));
    await step('/t screen', () => h.bridge.handle(message('/t screen', 'screen', topic)));
    const binding = h.bridge.store.forPane(pane.pane_id);
    await step('Refresh callback', () => h.bridge.handle({ kind: 'button', eventId: 'refresh',
      chatId: binding.chatId, openId: 'ou_test', topicId: topic,
      messageId: binding.cardId, nonce: binding.nonce, key: 'refresh' }));
    await h.bridge.handle(message('/t ls', 'picker'));
    await step('bound picker recovery', () => h.bridge.handle(pickerEvent(h, 'open')));
    h.fake.drop('pane.send_text');
    await step('needs_check screen', () => h.bridge.handle(message('/t raw uncertain', 'uncertain', topic)));
    assert.equal(h.bridge.store.forPane(pane.pane_id).needs_check, true);
    assert.match(h.feishu.calls.at(-1).content, /请先检查输入是否成功/);
    await h.restart();
    await step('restart refresh', () => h.bridge.tick());
    assert.ok(reads(h.fake).every(c => c.params.lines <= 6 + offset));
    if (!offset) assert.ok(reads(h.fake).every(c => c.params.source === 'visible'));
    else assert.ok(reads(h.fake).some(c => c.params.source === 'recent_unwrapped' && c.params.lines === 10));

    const other = h.fake.create(); other.scroll = { ...pane.scroll };
    await h.bridge.handle(message('/t ls', 'picker-new'));
    await step('unbound picker screen', () => h.bridge.handle(pickerEvent(h, 'open', 1)));
    assert.ok(h.bridge.store.forPane(other.pane_id)?.cardId);
  });
}
