import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { detectMenu, resumeWarnings } from '../src/menus.js';
import { screenCard, turnCard } from '../src/render.js';
import { harness, message } from './helpers.js';
import { resume, numbered, model, config } from './fixtures/ft17-menus.js';

const buttons = card => !card || typeof card !== 'object' ? [] :
  (card.tag === 'button' ? [card] : []).concat(Object.values(card).flatMap(value =>
    Array.isArray(value) ? value.flatMap(buttons) : value && typeof value === 'object' ? buttons(value) : []));
const keys = h => h.fake.calls.filter(call => call.method === 'pane.send_keys');
const binding = h => h.bridge.store.forPane('w1:p1');
const currentCard = h => {
  const b = binding(h);
  const call = h.feishu.calls.findLast(call => call.id === b.cardId && (call.type === 'patch' || call.msgType === 'interactive'));
  return call.card ?? call.content;
};
const click = (h, key, override = {}) => {
  const b = binding(h);
  return h.bridge.handle({ kind: 'button', eventId: randomUUID(), chatId: b.chatId, topicId: b.topicId,
    openId: 'ou_test', messageId: b.cardId, nonce: b.nonce, key, ...override });
};
async function openMenu(t, screen = resume, options = {}) {
  const h = await harness(t, options);
  const pane = h.fake.create();
  Object.assign(pane, { agent: 'claude', agent_status: 'idle', visible: screen, text: screen });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  await h.bridge.tick();
  return { h, pane };
}

test('ft17 idle and settled turn/status cards expose one-tap items; uncertain parsing has arrow/Enter fallback', () => {
  for (const card of [screenCard({ text: resume, status: 'idle', agent: 'claude', nonce: 'n' }),
    turnCard({ screen: resume, turn: { agent: 'Claude', text: 'Done', status: 'idle', settled: true }, nonce: 'n' })]) {
    assert.equal(card.header.template, 'orange');
    assert.match(JSON.stringify(card), /Claude 正在等你从菜单里选择.*Resume session/u);
    assert.deepEqual(buttons(card).map(button => button.value.key), ['menu:select:0', 'menu:select:1', 'menu:select:2', 'esc', 'refresh']);
    assert.ok(buttons(card).every(button => button.value.nonce === 'n'));
  }
  const fallback = 'Select model\nLoading options…\n↑/↓ to navigate · Enter to select · Esc to cancel';
  assert.deepEqual(detectMenu(fallback), { kind: 'list', title: 'Select model', items: [], cursorIndex: -1 });
  assert.deepEqual(buttons(screenCard({ text: fallback, status: 'idle' })).map(button => button.value.key), ['up', 'down', 'enter', 'esc', 'refresh']);
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
  const replay = { nonce: old.nonce, messageId: old.cardId };
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
  assert.ok(buttons(currentCard(h)).some(button => button.value.key === 'menu:confirm:1'));
  await click(h, 'menu:confirm:1', { nonce: old.nonce }); assert.equal(keys(h).length, 0);
  await h.restart();
  const confirm = binding(h);
  await click(h, 'menu:confirm:1');
  assert.deepEqual(keys(h).map(call => call.params.keys), [['down', 'enter']]);
  await click(h, 'menu:confirm:1', { nonce: confirm.nonce }); assert.equal(keys(h).length, 1);
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

test('ft17 transcript mode publishes idle menus before any turn and updates settled turns on menu screen changes', async t => {
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
  const oldId = binding(h).cardId;
  pane.visible = model; h.advance(2000); await h.bridge.tick();
  assert.equal(binding(h).cardId, oldId);
  assert.equal(buttons(currentCard(h))[0].text.content, 'Default (recommended)');
  pane.visible = '❯ '; h.advance(2000); await h.bridge.tick();
  assert.equal(buttons(currentCard(h)).length, 0);
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

test('ft17 menu labels are bounded and markup stays literal in status and turn cards', () => {
  const label = '<at id=all>中文🙂&`'.repeat(200);
  const screen = 'Select model\n❯ ' + label + '\n' + Array.from({ length: 11 }, () => '  ' + label).join('\n') + '\nEsc to cancel';
  for (const card of [screenCard({ text: screen, status: 'idle', nonce: 'n' }),
    turnCard({ screen, turn: { agent: 'Claude', text: '🙂'.repeat(2000), settled: true }, nonce: 'n' })]) {
    assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000);
    assert.ok(buttons(card).every(button => button.text.tag === 'plain_text' && Array.from(button.text.content).length <= 60));
    assert.ok(buttons(card).every(button => button.value.nonce === 'n'));
  }
});
