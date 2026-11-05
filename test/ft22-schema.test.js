import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, legacyHarness, message } from './helpers.js';
import { cardVersion, renderSchema, retirementCard } from '../src/card-schema.js';
import { screenCard, turnCard, menuCard, pickerCard } from '../src/render.js';
import { topicCard } from '../src/topics.js';
import { detectMenu } from '../src/menus.js';
import { actionEvent } from '../src/feishu.js';

const controls = card => {
  if (!card || typeof card !== 'object') return [];
  return (['button', 'interactive_container'].includes(card.tag) ? [card] : [])
    .concat(Object.values(card).flatMap(controls));
};
const turn = { id: 'turn', agent: 'Claude', status: 'blocked', text: 'Allow?', tools: '' };
const screen = 'Allow?\n1. First\n2. Second\n3. Third';
const options = { topicId: 'topic', nonce: 'nonce' };
const samples = {
  status: screenCard({ ...options, status: 'blocked', text: screen, suppressMenu: true }),
  turn: turnCard({ ...options, turn, screen, suppressMenu: true }),
  menu: menuCard({ ...options, menu: detectMenu('Allow this command?\n❯ 1. First\n  2. Second\nPress Enter to confirm · Esc to cancel') }),
  root: topicCard({ pane_id: 'pane', cwd: '/tmp' }, 'Title'),
  picker: pickerCard({ ...options, kind: 'list', entries: [{ paneId: 'pane', label: 'Shell' }] }),
};

for (const [kind, card] of Object.entries(samples)) test(`${kind} retains its sent schema across restart, opposite-schema patches and retirement`, async t => {
  const h = await harness(t), id = `card-${kind}`;
  await h.bridge.rememberCard(id, card, kind);
  await h.restart();
  const opposite = cardVersion(card) === '2.0' ? samples.status : samples.turn;
  await h.bridge.patchCard(id, opposite, kind);
  const patched = h.feishu.calls.at(-1).card;
  assert.equal(cardVersion(patched), cardVersion(card));
  assert.equal(controls(patched).length, controls(opposite).length);
  if (cardVersion(patched) === '2.0') for (const c of controls(patched)) {
    assert.equal(c.value, undefined); assert.equal(c.behaviors[0].type, 'callback');
  }
  await h.bridge.patchCard(id, retirementCard(), kind);
  const retired = h.feishu.calls.at(-1).card;
  assert.equal(cardVersion(retired), cardVersion(card));
  assert.equal(controls(retired).length, 0);
  assert.match(retired.header.title.content, /已结束/);
  assert.match(JSON.stringify(retired), /color='grey'/);
  assert.equal(h.bridge.store.data.cardSchemas[id].schemaVersion, cardVersion(card));
});

test('all known legacy kinds infer their original schema without a probe', async t => {
  const h = await harness(t);
  for (const [kind, card] of Object.entries(samples)) {
    await h.bridge.patchCard(`legacy-${kind}`, retirementCard(), kind);
    assert.equal(cardVersion(h.feishu.calls.at(-1).card), cardVersion(card));
  }
});

test('unknown legacy retirement retries 200830 with v2 once and persists that choice before retry, including restart', async t => {
  const h = await legacyHarness(t); await h.bridge.handle(message('pwd'));
  await h.store.update('oc_test', 'm1', { retiredCardId: 'legacy-unknown' });
  const attempts = [], patch = h.feishu.patch.bind(h.feishu);
  h.feishu.patch = async (id, card) => {
    if (id !== 'legacy-unknown') return patch(id, card);
    attempts.push(cardVersion(card));
    if (cardVersion(card) === '1.0') throw Object.assign(new Error('schema mismatch'), { code: '230099', detail: 'ErrCode: 200830' });
    assert.equal(h.bridge.store.data.cardSchemas[id].schemaVersion, '2.0');
    if (attempts.length === 2) throw Object.assign(new Error('offline'), { code: 'network_error' });
    return patch(id, card);
  };
  await h.bridge.retireCard(h.store.binding('oc_test', 'm1'));
  h.advance(2000); await h.restart();
  assert.deepEqual(attempts, ['1.0', '2.0', '2.0']);
  assert.equal(h.bridge.store.binding('oc_test', 'm1').retiredCardId, undefined);
});

test('unrelated card errors do not trigger a schema retry', async t => {
  const h = await harness(t); let attempts = 0;
  h.feishu.patch = async () => { attempts++; throw Object.assign(new Error('invalid'), { code: '230099' }); };
  await assert.rejects(h.bridge.patchCard('unknown', retirementCard()));
  assert.equal(attempts, 1);
});

test('persisted v2 payloads with old value fields are normalized on patch', async t => {
  const h = await harness(t), old = structuredClone(samples.turn);
  for (const button of controls(old)) {
    button.value = button.behaviors[0].value; delete button.behaviors;
  }
  await h.bridge.rememberCard('old-turn', old, 'turn');
  await h.restart();
  await h.bridge.patchCard('old-turn', old, 'turn');
  for (const button of controls(h.feishu.calls.at(-1).card)) {
    assert.equal(button.value, undefined); assert.equal(button.behaviors[0].type, 'callback');
  }
});

test('v2 turn keys and menu containers use behaviors and normalize to the existing callback envelope', () => {
  const buttons = controls(samples.turn);
  assert.deepEqual(buttons.map(b => b.behaviors[0].value.key), ['esc', '1', '2', '3', 'ctrl+c', 'refresh']);
  const menu = controls(samples.menu);
  assert.ok(menu.some(c => c.tag === 'interactive_container'));
  assert.ok(menu.some(c => c.tag === 'button'));
  for (const component of [...buttons, ...menu, ...controls(renderSchema(samples.picker, '2.0'))]) {
    assert.equal(component.value, undefined);
    assert.equal(component.behaviors[0].type, 'callback');
    const event = actionEvent({ event: { action: { value: component.behaviors[0].value }, context: { open_message_id: 'card' } } });
    assert.equal(event.topicId, 'topic'); assert.equal(event.nonce, 'nonce');
    assert.equal(event.key, component.behaviors[0].value.key);
  }
});

test('callback receipt is logged before ACL, dedupe, stale/unknown validation and failed durable claims without user content', async t => {
  const h = await harness(t);
  const event = { kind: 'button', eventId: randomUUID(), chatId: 'wrong-chat', topicId: 'topic',
    messageId: 'card', openId: 'unknown', key: 'SECRET', nonce: 'SECRET', text: 'SECRET' };
  await h.bridge.handle(event); await h.bridge.handle(event);
  await h.bridge.handle({ ...event, eventId: randomUUID(), chatId: 'oc_test', openId: 'ou_test' });
  await h.bridge.accept({ kind: 'button', eventId: randomUUID() }); await h.bridge.queue;
  const claim = h.bridge.store.claim;
  h.bridge.store.claim = async () => { throw new Error('disk'); };
  await assert.rejects(h.bridge.accept(event)); h.bridge.store.claim = claim;
  const logs = h.errors.filter(line => line.startsWith('card_action_received '));
  assert.equal(logs.length, 5);
  assert.deepEqual(JSON.parse(logs[0].slice(logs[0].indexOf(' ') + 1)), { kind: 'button', topic: 'topic', cardId: 'card' });
  assert.ok(logs.every(line => !line.includes('SECRET')));
  assert.deepEqual(JSON.parse(logs[3].slice(logs[3].indexOf(' ') + 1)), { kind: 'button', topic: null, cardId: null });
});
