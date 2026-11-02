import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { detectMenu, resumeWarnings } from '../src/menus.js';
import { menuCard } from '../src/render.js';
import { legacyHarness as harness, message } from './helpers.js';
import { resume, numbered, model, config } from './fixtures/ft17-menus.js';

const buttons = card => !card || typeof card !== 'object' ? [] :
  (card.behaviors?.[0]?.type === 'callback' ? [{ ...card, value: card.behaviors[0].value, text: card.text ?? { content: card.elements?.[0]?.content ?? '' } }] : card.tag === 'button' ? [card] : []).concat(Object.values(card).flatMap(value =>
    Array.isArray(value) ? value.flatMap(buttons) : value && typeof value === 'object' ? buttons(value) : []));
const keys = h => h.fake.calls.filter(call => call.method === 'pane.send_keys');
const binding = h => h.bridge.store.forPane('w1:p1');
const currentCard = h => {
  const b = binding(h);
  const call = h.feishu.calls.findLast(call => call.id === b.menuCardId && (call.type === 'patch' || call.msgType === 'interactive'));
  return call.card ?? call.content;
};
const click = (h, key, override = {}) => {
  const b = binding(h);
  return h.bridge.handle({ kind: 'button', eventId: randomUUID(), chatId: b.chatId, topicId: b.topicId,
    openId: 'ou_test', messageId: b.menuCardId, nonce: b.menuNonce, key, ...override });
};
async function openMenu(t, screen = resume, options = {}) {
  const h = await harness(t, options);
  const pane = h.fake.create();
  Object.assign(pane, { agent: 'claude', agent_status: 'idle', visible: screen, text: screen });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  await h.bridge.tick();
  return { h, pane };
}

test('ft18 separate menu cards expose one-tap items; uncertain parsing has arrow/Enter fallback', () => {
  for (const card of [menuCard({ menu: detectMenu(resume), nonce: 'n' })]) {
    assert.equal(card.header.template, 'orange');
    assert.match(JSON.stringify(card), /Claude 正在等你从菜单里选择.*Resume session/u);
    assert.deepEqual(buttons(card).map(button => button.value.key), ['menu:select:0', 'menu:select:1', 'menu:select:2', 'esc', 'refresh']);
    assert.ok(buttons(card).every(button => button.value.nonce === 'n'));
  }
  const fallback = 'Select model\nLoading options…\n↑/↓ to navigate · Enter to select · Esc to cancel';
  assert.deepEqual(detectMenu(fallback), { kind: 'list', title: 'Select model', items: [], cursorIndex: -1 });
  assert.deepEqual(buttons(menuCard({ menu: detectMenu(fallback) })).map(button => button.value.key), ['up', 'down', 'enter', 'esc', 'refresh']);
});

test('ft17 idle list taps send exactly the arrows needed and Enter, including up and current selection', async t => {
  for (const [screen, target, expected] of [[resume, 2, ['down', 'down', 'enter']],
    [config, 0, ['up', 'enter']], [config, 1, ['enter']]]) {
    const { h } = await openMenu(t, screen);
    assert.ok(buttons(currentCard(h)).some(button => button.value.key === `menu:select:${target}`));
    const before = keys(h).length;
    await click(h, `menu:select:${target}`);
    assert.deepEqual(keys(h).slice(before).map(call => call.params.keys), [expected]);
    assert.equal(h.fake.calls.filter(call => ['pane.send_text', 'agent.prompt'].includes(call.method)).length, 0);
  }
});

test('ft17 changed cursor/items/title refuse without sending any movement and offer a refreshed card', async t => {
  for (const changed of [config.replace('› Language', '  Language').replace('  Theme', '› Theme'),
    config.replace('Notifications', 'Privacy'), config.replace('Settings', 'Configuration')]) {
    const { h, pane } = await openMenu(t, config);
    pane.visible = changed;
    const before = keys(h).length;
    await click(h, 'menu:select:2');
    assert.equal(keys(h).length, before);
    assert.ok(h.feishu.calls.some(call => call.content === '菜单已变化，请刷新'));
    h.advance(1000); await h.bridge.tick();
    assert.deepEqual(binding(h).cardMenu, detectMenu(changed));
  }
});

test('ft17 rechecks a menu changed during the duplicate lookup immediately before writing keys', async t => {
  const { h, pane } = await openMenu(t);
  const original = h.bridge.herdr.request.bind(h.bridge.herdr);
  h.bridge.herdr.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'pane.list') pane.visible = resume.replace('钻进robot大脑方案', 'Another session');
    return result;
  };
  await click(h, 'menu:select:2');
  assert.equal(keys(h).length, 0);
  assert.ok(h.feishu.calls.some(call => call.content === '菜单已变化，请刷新'));
});

test('ft17 nonce is single-use across new event IDs and restart; ACL, topic/card identity and expiry still apply', async t => {
  const { h } = await openMenu(t);
  const old = binding(h);
  for (const override of [{ openId: 'unauthorized' }, { topicId: 'foreign' }, { messageId: 'foreign' }, { nonce: 'old' }, { key: 'menu:select:999' }, { key: 'menu:confirm:1' }]) {
    await click(h, 'menu:select:1', override);
  }
  assert.equal(keys(h).length, 0);
  await click(h, 'menu:select:1');
  assert.equal(keys(h).length, 1);
  const replay = { nonce: old.menuNonce, messageId: old.menuCardId };
  await click(h, 'menu:select:1', replay);
  await h.restart();
  await click(h, 'menu:select:1', replay);
  assert.equal(keys(h).length, 1);
  h.advance(600000); await click(h, 'menu:select:1');
  assert.equal(keys(h).length, 1);
});

test('ft17 resume duplicate title warning requires a fresh second tap, persists across restart, then selects once', async t => {
  const { h } = await openMenu(t);
  const other = h.fake.create();
  Object.assign(other, { agent: 'claude', agent_status: 'working', terminal_title_stripped: 'paper30-reloading 研究交接文档' });
  h.advance(1000); await h.bridge.tick();
  const old = binding(h);
  assert.match(buttons(currentCard(h)).find(button => button.value.key === 'menu:select:1').text.content, /⚠️ 已在 .*w1:p2.* 运行/u);
  await click(h, 'menu:select:1'); assert.equal(keys(h).length, 0);
  h.advance(1000); await h.bridge.tick();
  assert.match(JSON.stringify(currentCard(h)), /同时恢复可能损坏会话记录/u);
  assert.equal(binding(h).menuCardId, old.menuCardId);
  assert.ok(buttons(currentCard(h)).some(button => button.value.key === 'menu:confirm:1'));
  await click(h, 'menu:confirm:1', { nonce: old.menuNonce }); assert.equal(keys(h).length, 0);
  await h.restart();
  const confirm = binding(h);
  await click(h, 'menu:confirm:1');
  assert.deepEqual(keys(h).map(call => call.params.keys), [['down', 'enter']]);
  await click(h, 'menu:confirm:1', { nonce: confirm.menuNonce }); assert.equal(keys(h).length, 1);
});

test('ft17 newly live duplicate is checked at tap time; confirmation can return to the menu with no terminal input', async t => {
  const { h } = await openMenu(t);
  const other = h.fake.create();
  Object.assign(other, { agent: 'claude', terminal_title_stripped: 'Metame 飞书双端同步' });
  await click(h, 'menu:select:0'); assert.equal(keys(h).length, 0);
  h.advance(1000); await h.bridge.tick();
  await click(h, 'menu:back'); h.advance(1000); await h.bridge.tick();
  assert.equal(keys(h).length, 0); assert.equal(binding(h).menuConfirm, null);
  assert.ok(buttons(currentCard(h)).some(button => button.value.key === 'menu:select:0'));
  assert.deepEqual(resumeWarnings(detectMenu(model), [other], 'w1:p1'), {});
  assert.deepEqual(resumeWarnings(detectMenu(resume), [{ ...other, agent: 'codex' }], 'w1:p1'), {});
});

test('ft17 a moved cursor invalidates duplicate confirmation and a reused pane identity requires a new confirmation', async t => {
  for (const changed of ['cursor', 'identity']) {
    const { h, pane } = await openMenu(t);
    const other = h.fake.create();
    Object.assign(other, { agent: 'claude', terminal_title_stripped: 'Metame 飞书双端同步' });
    await click(h, 'menu:select:0'); h.advance(1000); await h.bridge.tick();
    if (changed === 'cursor') pane.visible = resume.replace('   ❯ Metame', '     Metame').replace('     paper30', '   ❯ paper30');
    else other.terminal_id = 'replacement-terminal';
    await click(h, 'menu:confirm:0');
    assert.equal(keys(h).length, 0);
    if (changed === 'cursor') assert.ok(h.feishu.calls.some(call => call.content === '菜单已变化，请刷新'));
    else assert.equal(binding(h).menuConfirm.warnings[0].terminalId, 'replacement-terminal');
  }
});

test('ft17 lists over ten items paginate by tapping More; selection retains absolute index and exact arrows', async t => {
  const many = 'Select model\n❯ Model 0\n' + Array.from({ length: 11 }, (_, i) => `  Model ${i + 1}`).join('\n') + '\n↑/↓ to navigate · Esc to cancel';
  const { h } = await openMenu(t, many);
  assert.equal(buttons(currentCard(h)).filter(button => button.value.key.startsWith('menu:select:')).length, 10);
  assert.ok(buttons(currentCard(h)).some(button => button.value.key === 'up'));
  await click(h, 'menu:more'); assert.equal(keys(h).length, 0);
  h.advance(1000); await h.bridge.tick();
  assert.deepEqual(buttons(currentCard(h)).filter(button => button.value.key.startsWith('menu:select:')).map(button => button.value.key), ['menu:select:10', 'menu:select:11']);
  await click(h, 'menu:select:11');
  assert.deepEqual(keys(h).map(call => call.params.keys), [[...Array(11).fill('down'), 'enter']]);
});

test('ft17 fallback arrows/Enter, Esc cancel and idle numbered permission buttons send only their displayed keys', async t => {
  for (const [screen, key] of [[resume, 'esc'], [numbered, '2'],
    ['Select model\nLoading…\n↑/↓ to navigate · Enter to select · Esc to cancel', 'down'],
    ['Select model\nLoading…\n↑/↓ to navigate · Enter to select · Esc to cancel', 'enter']]) {
    const { h } = await openMenu(t, screen);
    assert.ok(buttons(currentCard(h)).some(button => button.value.key === key));
    await click(h, key); assert.deepEqual(keys(h).map(call => call.params.keys), [[key]]);
  }
});

test('ft17 fallback menus reject a changed raw screen even when the parsed empty menu stays the same', async t => {
  const { h, pane } = await openMenu(t, 'Select model\nLoading options…\nEsc to cancel');
  const menu = binding(h).cardMenu;
  pane.visible = 'Select model\nOptions have changed…\nEsc to cancel';
  assert.deepEqual(detectMenu(pane.visible), menu);
  await click(h, 'enter'); assert.equal(keys(h).length, 0);
  assert.ok(h.feishu.calls.some(call => call.content === '菜单已变化，请刷新'));
});

test('ft17 fallback Enter also warns about a live resume duplicate and requires a second tap', async t => {
  const screen = 'Resume session\n❯ Existing session\n  Details not understood\nEsc to cancel';
  const { h } = await openMenu(t, screen);
  const other = h.fake.create();
  Object.assign(other, { agent: 'claude', terminal_title_stripped: 'Existing session' });
  h.advance(1000); await h.bridge.tick();
  assert.deepEqual(binding(h).cardMenu.items, []);
  assert.match(buttons(currentCard(h)).find(button => button.value.key === 'enter').text.content, /⚠️ 已在 w1:p2/u);
  await click(h, 'enter'); assert.equal(keys(h).length, 0);
  h.advance(1000); await h.bridge.tick();
  await click(h, 'menu:confirm:0');
  assert.deepEqual(keys(h).map(call => call.params.keys), [['enter']]);
});

test('ft18 transcript mode publishes idle menus before any turn and keeps menu identity on screen changes', async t => {
  const records = [];
  const adapter = { locate: async () => 'menus.jsonl', read: async (_path, cursor) => ({
    cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
  }) };
  const { h, pane } = await openMenu(t, config, { adapters: { claude: adapter } });
  assert.ok(buttons(currentCard(h)).some(button => button.value.key === 'menu:select:2'));
  records.push({ role: 'assistant', text: 'Completed before opening the menu.' });
  h.advance(2000); await h.bridge.tick(); h.advance(2000); await h.bridge.tick();
  assert.equal(binding(h).turn.settled, true);
  assert.equal(currentCard(h).schema, '2.0');
  const oldId = binding(h).menuCardId;
  pane.visible = model; h.advance(2000); await h.bridge.tick();
  assert.equal(binding(h).menuCardId, oldId);
  assert.match(buttons(currentCard(h))[0].text.content, /Default \(recommended\)/);
  pane.visible = '❯ '; h.advance(2000); await h.bridge.tick();
  assert.equal(binding(h).menuCardId, null);
});

test('ft17 card snapshots and tap validation use the same full viewport in a terminal taller than forty rows', async t => {
  const h = await harness(t);
  const pane = h.fake.create();
  Object.assign(pane, { agent: 'claude', agent_status: 'idle', visible:
    'Select model\n❯ Default\n  Sonnet\n  Haiku\n' + '\n'.repeat(60) + 'Esc to cancel' });
  pane.scroll.viewport_rows = 66;
  const original = h.bridge.herdr.request.bind(h.bridge.herdr);
  h.bridge.herdr.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'pane.read' && params.source === 'visible') result.read.text = result.read.text.split('\n').slice(-params.lines).join('\n');
    return result;
  };
  await h.bridge.handle(message('/t open w1:p1', 'open')); await h.bridge.tick();
  assert.equal(binding(h).cardMenu.items[1].label, 'Sonnet');
  await click(h, 'menu:select:1');
  assert.deepEqual(keys(h).map(call => call.params.keys), [['down', 'enter']]);
  assert.ok(h.fake.calls.filter(call => call.method === 'pane.read' && call.params.source === 'visible').every(call => call.params.lines === 66));
});

test('ft18 full labels survive byte-budget pagination and markup stays literal', () => {
  const label = '<at id=all>\u4e2d\u6587\ud83d\ude42&`'.repeat(200);
  const menu = { kind: 'list', title: 'Select model', cursorIndex: 0,
    items: Array.from({ length: 12 }, () => ({ label, sublabel: '4 seconds ago / HEAD / 7.1MB' })) };
  const card = menuCard({ menu, nonce: 'n' });
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000);
  const rows = card.body.elements.filter(e => e.tag === 'interactive_container');
  assert.ok(rows.length < 10);
  assert.ok(rows[0].elements[0].content.includes('id=all&gt;'));
  assert.ok(rows[0].elements[0].content.includes('\u4e2d\u6587'));
  assert.ok(rows.every(row => row.width === 'fill' && row.behaviors[0].value.nonce === 'n'));
});
