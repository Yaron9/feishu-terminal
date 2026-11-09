import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { detectMenu, approvalContext } from '../src/menus.js';
import { menuCard } from '../src/render.js';
import { legacyHarness as harness, message } from './helpers.js';

// Claude Code screen (a): boxless permission prompt (older builds draw │ borders).
const permission = [
  ' Bash command',
  '',
  '   ssh -n win2 "cd /d D:\\work && pi -p ..."  ',
  '   Run the review with pi on DeepSeek',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for ssh commands in /home/ubuntu",
  '   3. No, and tell Claude what to do differently (esc)',
].join('\n');

// Claude Code screen (b): session rating survey shown at the idle prompt.
const survey = '● How is Claude doing this session? (optional)\n' +
  '  1: Bad    2: Fine   3: Good   0: Dismiss';

const labels = menu => menu.items.map(item => item.label);
const cardKeys = card => {
  const keys = [];
  JSON.stringify(card, (key, value) => {
    if (key === 'key' && typeof value === 'string') keys.push(value.replace(/^menu:(?:select|confirm):/, ''));
    return value;
  });
  return keys;
};
const text = value => JSON.stringify(value);

test('w16m the permission prompt is a menu with its question, command and full labels', () => {
  for (const status of ['blocked', 'idle']) {
    const menu = detectMenu(permission, { status, cli: 'claude' });
    assert.equal(menu.kind, 'numbered', `status ${status}`);
    assert.match(menu.title, /Do you want to proceed\?/);
    assert.deepEqual(labels(menu), ['Yes', "Yes, and don't ask again for ssh commands in /home/ubuntu",
      'No, and tell Claude what to do differently (esc)']);
    assert.deepEqual(menu.items.map(item => item.key), ['1', '2', '3']);
    // The reason to decide has to survive onto the card: the command, in full.
    assert.match(approvalContext(permission), /ssh -n win2 "cd \/d D:\\work && pi -p \.\.\."/);
    const card = menuCard({ menu, topicId: 'topic', nonce: 'nonce' }), json = text(card);
    assert.match(json, /Do you want to proceed\?/);
    assert.match(json, /Run the review with pi on DeepSeek/);
    assert.ok(json.includes('ssh -n win2'));
    for (const label of labels(menu)) assert.ok(json.includes(label), label);
    for (const key of ['1', '2', '3', 'esc', 'refresh']) assert.ok(cardKeys(card).includes(key), key);
  }
});

test('w16m the rating survey is a menu with its four options and a dismiss key', () => {
  const menu = detectMenu(survey, { status: 'idle', cli: 'claude' });
  assert.equal(menu.kind, 'numbered');
  assert.match(menu.title, /How is Claude doing this session\?/);
  assert.deepEqual(labels(menu), ['Bad', 'Fine', 'Good', 'Dismiss']);
  assert.deepEqual(menu.items.map(item => item.key), ['1', '2', '3', '0']);
  assert.equal(menu.dismissKey, '0');
  const card = menuCard({ menu, topicId: 'topic', nonce: 'nonce' }), json = text(card);
  assert.match(json, /How is Claude doing this session\?/);
  for (const label of ['Bad', 'Fine', 'Good', 'Dismiss']) assert.ok(json.includes(label), label);
  for (const key of ['1', '2', '3', '0']) assert.ok(cardKeys(card).includes(key), key);
});

const bound = h => h.bridge.store.forPane('w1:p1');
const payload = c => c.card ?? c.content;
const sent = h => h.fake.calls.filter(c => ['pane.send_keys', 'pane.send_text', 'agent.prompt'].includes(c.method))
  .map(c => c.method === 'pane.send_keys' ? `keys:${c.params.keys.join('+')}` :
    c.method === 'agent.prompt' ? `prompt:${c.params.text}` : `text:${c.params.text}`);

async function setup(t) {
  const h = await harness(t), pane = h.fake.create();
  Object.assign(pane, { agent: 'claude', agent_status: 'idle', visible: 'Ready', text: 'Ready' });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  return { h, pane };
}
async function screen(h, pane, value) {
  pane.visible = value; pane.text = value; h.advance(2000); await h.bridge.tick();
}
async function tap(h, key, id) {
  const b = bound(h);
  await h.bridge.handle({ kind: 'button', eventId: randomUUID(), chatId: b.chatId, topicId: b.topicId,
    openId: 'ou_test', messageId: id ?? b.menuCardId ?? b.cardId, nonce: b.menuNonce ?? b.nonce, key });
}
const cardFor = (h, id) => payload(h.feishu.calls.filter(c => c.id === id && ['reply', 'patch'].includes(c.type)).at(-1));

test('w16m an idle permission prompt gets a card with the question and three option buttons', async t => {
  const { h, pane } = await setup(t);
  await screen(h, pane, permission);
  const b = bound(h);
  assert.equal(b.cardMenu?.kind, 'numbered');
  const json = text(cardFor(h, b.menuCardId ?? b.cardId));
  assert.ok(!json.includes('当前屏幕'), 'a pending question must never be a bare screen dump');
  assert.match(json, /Do you want to proceed\?/);
  assert.ok(json.includes('ssh -n win2'));
  assert.ok(json.includes("Yes, and don't ask again for ssh commands in /home/ubuntu"));
  await tap(h, '2');
  assert.deepEqual(sent(h), ['keys:2']);
  const patched = text(h.feishu.calls.findLast(c => c.type === 'patch'));
  assert.match(patched, /已选择：/);
  assert.match(patched, /已选择：2\. Yes, and don't ask again for ssh commands in \/home\/ubuntu/);
});

test('w16m the survey gets a small card with four buttons and tapping Dismiss sends 0', async t => {
  const { h, pane } = await setup(t);
  await screen(h, pane, survey);
  const b = bound(h);
  assert.equal(b.cardMenu?.kind, 'numbered');
  const json = text(cardFor(h, b.menuCardId ?? b.cardId));
  assert.match(json, /How is Claude doing this session\?/);
  for (const label of ['Bad', 'Fine', 'Good', 'Dismiss']) assert.ok(json.includes(label), label);
  await tap(h, '0');
  assert.deepEqual(sent(h), ['keys:0']);
  assert.match(text(h.feishu.calls.findLast(c => c.type === 'patch')), /已选择：0\. Dismiss/);
});

test('w16m a text message while the survey is up dismisses it with 0 before the text', async t => {
  const { h, pane } = await setup(t);
  await screen(h, pane, survey);
  await h.bridge.handle(message('请把构建日志发我', 'm2', bound(h).topicId));
  const order = sent(h);
  assert.equal(order[0], 'keys:0');
  assert.ok(order.includes('prompt:请把构建日志发我'), JSON.stringify(order));
});

test('w16m refreshing a stale card while the screen asks shows the question, not the screen dump', async t => {
  const { h, pane } = await setup(t);
  const statusId = bound(h).cardId;
  await screen(h, pane, survey);
  assert.ok(bound(h).menuCardId && bound(h).menuCardId !== statusId);
  const b = bound(h);
  await h.bridge.changedCard(b, { eventId: 'e1', chatId: b.chatId, topicId: b.topicId, openId: 'ou_test',
    messageId: statusId, nonce: b.nonce, key: 'refresh' });
  const json = text(h.feishu.calls.findLast(c => c.type === 'patch' && c.id === statusId).card);
  assert.ok(!json.includes('当前屏幕'), json.slice(0, 300));
  assert.match(json, /How is Claude doing this session\?/);
  for (const label of ['Bad', 'Fine', 'Good', 'Dismiss']) assert.ok(json.includes(label), label);
});

test('w16m a settled screen with nothing to choose keeps the plain status card', async t => {
  const { h, pane } = await setup(t);
  await screen(h, pane, 'Ready\nDone thinking.');
  const before = h.feishu.calls.length;
  await screen(h, pane, 'Ready\nDone thinking.\nReady to help.');
  assert.equal(text(h.feishu.calls.slice(before)).includes('当前屏幕'), false);
});
