import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { menuCard } from '../src/render.js';
import { detectMenu } from '../src/menus.js';
import { legacyHarness as harness, message } from './helpers.js';
import { resume, model } from './fixtures/ft17-menus.js';

const bound = h => h.bridge.store.forPane('w1:p1');
const payload = c => c.card ?? c.content;
const tap = (h, key) => {
  const b = bound(h);
  return h.bridge.handle({ kind: 'button', eventId: randomUUID(), chatId: b.chatId,
    topicId: b.topicId, openId: 'ou_test', messageId: b.menuCardId, nonce: b.menuNonce, key });
};
async function setup(t, options = {}) {
  const h = await harness(t, options), pane = h.fake.create();
  Object.assign(pane, { agent: 'claude', agent_status: 'idle', visible: 'Ready', text: 'Ready' });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  return { h, pane };
}
async function screen(h, pane, text) {
  pane.visible = text; h.advance(2000); await h.bridge.tick();
}

test('ft18 menu posts its own reply; cursor/items/pages/confirm patch it and preserve the status card', async t => {
  const { h, pane } = await setup(t);
  const statusId = bound(h).cardId, before = h.feishu.calls.length;
  await screen(h, pane, resume);
  const id = bound(h).menuCardId;
  assert.ok(id && id !== statusId);
  assert.ok(h.feishu.calls.slice(before).some(c => c.type === 'reply' && c.id === id));
  await screen(h, pane, model);
  assert.equal(bound(h).menuCardId, id);
  assert.ok(h.feishu.calls.some(c => c.type === 'patch' && c.id === id));
  assert.equal(h.feishu.calls.slice(before).filter(c => c.id === statusId).length, 0);
  const many = 'Select model\n❯ Model 0\n' + Array.from({ length: 12 }, (_, i) => `  Model ${i + 1}`).join('\n') + '\nEsc to cancel';
  await screen(h, pane, many);
  await tap(h, 'menu:more'); h.advance(1000); await h.bridge.tick();
  assert.equal(bound(h).menuCardId, id);
  assert.equal(bound(h).menuPage, 1);
  assert.equal(h.feishu.calls.slice(before).filter(c => c.id === statusId).length, 0);
});

test('ft18 close/select finalizes only the menu with no controls; later menu gets a fresh card, including after restart', async t => {
  for (const select of [false, true]) {
    const { h, pane } = await setup(t);
    await screen(h, pane, resume);
    const id = bound(h).menuCardId, statusId = bound(h).cardId;
    await h.restart();
    assert.equal(bound(h).menuCardId, id);
    const original = h.bridge.herdr.request.bind(h.bridge.herdr);
    h.bridge.herdr.request = async (method, params) => {
      const result = await original(method, params);
      if (method === 'pane.send_keys') pane.visible = 'Ready';
      return result;
    };
    await tap(h, select ? 'menu:select:1' : 'esc');
    h.advance(1000); await h.bridge.tick();
    assert.equal(bound(h).menuCardId, null);
    const final = payload(h.feishu.calls.findLast(c => c.type === 'patch' && c.id === id));
    assert.equal(final.header.template, select ? 'green' : 'grey');
    assert.match(JSON.stringify(final), select ? /已选择：paper30-reloading 研究交接文档/ : /菜单已关闭/);
    assert.ok(!/behaviors|"button"|interactive_container/.test(JSON.stringify(final)));
    await h.restart(); await screen(h, pane, resume);
    assert.ok(bound(h).menuCardId && bound(h).menuCardId !== id && bound(h).menuCardId !== statusId);
  }
});

test('ft18 settled transcript turn is left untouched while a separate menu opens and updates', async t => {
  const records = [], adapter = { locate: async () => 'turn.jsonl', read: async (_path, cursor) => ({
    cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
  }) };
  const { h, pane } = await setup(t, { adapters: { claude: adapter } });
  records.push({ role: 'assistant', text: 'Completed answer' });
  await screen(h, pane, 'Ready'); await screen(h, pane, 'Ready');
  assert.equal(bound(h).turn.settled, true);
  const turnId = bound(h).cardId, before = h.feishu.calls.length;
  await screen(h, pane, resume); await screen(h, pane, model);
  assert.equal(bound(h).cardId, turnId);
  assert.ok(bound(h).menuCardId !== turnId);
  assert.equal(h.feishu.calls.slice(before).filter(c => c.id === turnId).length, 0);
});

test('ft18 resume snapshot uses vertically stacked full labels, grey details, cursor and callback safety values', async () => {
  const card = menuCard({ menu: detectMenu(resume), topicId: 'topic', nonce: 'nonce' });
  const expected = JSON.parse(await readFile(new URL('./fixtures/ft18-resume-card.json', import.meta.url), 'utf8'));
  assert.deepEqual(card, expected);
  const rows = card.body.elements.filter(e => e.tag === 'interactive_container');
  assert.equal(rows.length, 3);
  rows.forEach((row, i) => {
    assert.equal(row.width, 'fill');
    assert.ok(row.elements[0].content.includes(detectMenu(resume).items[i].label));
    assert.ok(row.elements[0].content.includes("<font color='grey'>"));
    assert.deepEqual(row.behaviors, [{ type: 'callback', value: { topic_id: 'topic', nonce: 'nonce', key: `menu:select:${i}` } }]);
  });
  assert.ok(rows[0].elements[0].content.startsWith('▶ '));
  assert.ok(!/column_set|"action"/.test(JSON.stringify(card)));
});

test('ft18 long Chinese titles remain whole across reduced pages, and hidden indices cannot be tapped', async t => {
  const title = '这是必须完整展示的中文会话标题'.repeat(90);
  const text = 'Select model\n❯ ' + title + '0\n' + Array.from({ length: 11 }, (_, i) => `  ${title}${i + 1}`).join('\n') + '\nEsc to cancel';
  const { h, pane } = await setup(t);
  await screen(h, pane, text);
  const b = bound(h), card = payload(h.feishu.calls.findLast(c => c.id === b.menuCardId));
  assert.ok(b.menuPageSize < 10);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000);
  assert.ok(card.body.elements[2].elements[0].content.includes(title + '0'));
  await tap(h, `menu:select:${b.menuPageSize}`);
  assert.equal(h.fake.calls.filter(c => c.method === 'pane.send_keys').length, 0);
  await tap(h, 'menu:more'); h.advance(1000); await h.bridge.tick();
  const next = payload(h.feishu.calls.findLast(c => c.id === b.menuCardId));
  assert.ok(next.body.elements[2].elements[0].content.includes(title + b.menuPageSize));
  assert.ok(Buffer.byteLength(JSON.stringify(next)) < 28000);
});

test('ft18 an uncertain menu reply retries the persisted UUID across restart and recovery preserves its identity', async t => {
  const { h, pane } = await setup(t);
  const original = h.feishu.reply.bind(h.feishu);
  let failed = false;
  h.feishu.reply = async (...args) => {
    const id = await original(...args);
    if (!failed && args[1]?.header?.title?.content === 'Claude · 等待菜单选择') {
      failed = true; throw new Error('Lost reply acknowledgement');
    }
    return id;
  };
  await screen(h, pane, resume);
  const pending = bound(h).pendingMenuCard;
  assert.ok(pending?.uuid);
  await h.restart(); h.advance(2000); await h.bridge.tick();
  assert.equal(bound(h).pendingMenuCard, null);
  assert.deepEqual(h.feishu.calls.filter(c => c.uuid === pending.uuid).map(c => c.uuid), [pending.uuid, pending.uuid]);
  const id = bound(h).menuCardId;
  await h.bridge.handle(message('/t open w1:p1', 'reopen'));
  assert.equal(bound(h).menuCardId, id);
  assert.ok(!bound(h).pendingCard);
});
