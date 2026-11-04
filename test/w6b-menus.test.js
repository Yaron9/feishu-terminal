import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { legacyHarness as harness, message } from './helpers.js';
import { detectMenu } from '../src/menus.js';
import { menuCard } from '../src/render.js';

const screens = {
  claude: 'Unrelated previous answer\n\nBash command\n\n  npm test -- --runInBand\n  Run the test suite\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again\n  3. No\nEsc to cancel',
  codex: 'Old output\n\nCommand\n  python verify.py --input fixture.txt\nWould you like to run the following command?\n❯ 1. Yes, proceed\n  2. No, tell Codex what to do differently\nEsc to cancel',
  pi: 'Old output\n\n╭────────────────────────────╮\n│ Tool: bash\n│ npm test\n│ Allow this command?\n│ 1. Yes\n│ 2. No\n╰────────────────────────────╯\nEsc to cancel',
};
const bound = h => h.bridge.store.forPane('w1:p1');
const keys = h => h.fake.calls.filter(c => c.method === 'pane.send_keys');
const inputs = h => h.fake.calls.filter(c => ['pane.send_text', 'agent.prompt'].includes(c.method));
const click = (h, key, props = {}) => {
  const b = bound(h);
  return h.bridge.handle({ kind: 'button', eventId: randomUUID(), chatId: b.chatId, topicId: b.topicId,
    openId: 'ou_test', messageId: b.menuCardId ?? b.cardId, nonce: b.menuNonce ?? b.nonce, key, ...props });
};
async function setup(t, screen = screens.claude) {
  const h = await harness(t), pane = h.fake.create();
  Object.assign(pane, { agent: 'claude', agent_status: 'blocked', visible: screen, text: screen });
  await h.bridge.handle(message('/t open w1:p1', 'open')); await h.bridge.tick();
  return { h, pane };
}

for (const [cli, screen] of Object.entries(screens)) test(`${cli} permission card shows command context, question and full labels`, () => {
  const menu = detectMenu(screen), card = menuCard({ menu, topicId: 'topic', nonce: 'fixture', agent: cli });
  assert.ok(card.header.title.content.startsWith(cli));
  assert.equal(menu.kind, 'numbered');
  assert.match(menu.context, cli === 'codex' ? /python verify.py --input fixture.txt/ : /npm test/);
  assert.ok(!menu.context.includes('Old output') && !menu.context.includes('Unrelated previous'));
  const text = JSON.stringify(card);
  assert.ok(text.includes(menu.title));
  assert.ok(menu.items.every(item => text.includes(item.label)));
});

test('context stops at a blank block, is bounded to twelve lines, and escapes terminal markup', () => {
  const screen = 'Older secret block\n\n' + Array.from({ length: 20 }, (_, i) => `command ${i}`).join('\n') +
    '\n<at id=all>\nAllow this command?\n1. Yes\n2. No\nEsc to cancel';
  const menu = detectMenu(screen), card = menuCard({ menu });
  assert.ok(menu.context.split('\n').length <= 12);
  assert.ok(!menu.context.includes('Older secret'));
  assert.ok(!JSON.stringify(card).includes('<at id=all>'));
  assert.match(JSON.stringify(card), /&lt;at id=all&gt;/);
});

test('an unchanged menu remains actionable after a day and restart, with single-use nonce checks', async t => {
  const { h } = await setup(t), original = bound(h);
  h.advance(86400001); await h.restart();
  await click(h, '1'); assert.equal(keys(h).length, 1);
  await click(h, '1', { nonce: original.menuNonce, messageId: original.menuCardId });
  assert.equal(keys(h).length, 1);
});

for (const changed of ['choices', 'context', 'gone']) test(`a ${changed} menu is refreshed in the same card with no selection`, async t => {
  const { h, pane } = await setup(t), original = bound(h);
  pane.visible = changed === 'choices' ? screens.claude.replace('1. Yes', '1. Run once') :
    changed === 'context' ? screens.claude.replace('npm test -- --runInBand', 'npm run deploy') : 'Build finished. Ready.';
  await click(h, '1');
  assert.equal(keys(h).length, 0);
  const patch = h.feishu.calls.findLast(c => c.type === 'patch' && c.id === original.menuCardId);
  assert.ok(patch);
  assert.match(JSON.stringify(patch.card), changed === 'choices' ? /Run once/ : changed === 'context' ? /npm run deploy/ : /Build finished/);
  assert.ok(h.feishu.calls.some(c => c.content === '菜单已变化，已更新卡片。'));
  if (changed !== 'gone') { await click(h, '1'); assert.equal(keys(h).length, 1); }
});

for (const [reply, key] of [['1', '1'], ['2', '2'], ['y', '1'], ['n', '3']]) test(`plain topic reply ${reply} selects the current permission via keys`, async t => {
  const { h } = await setup(t), b = bound(h);
  await h.bridge.handle(message(reply, 'choice', b.topicId));
  assert.deepEqual(keys(h).map(c => c.params.keys), [[key]]);
  assert.equal(inputs(h).length, 0);
  await h.bridge.handle(message(reply, 'choice', b.topicId)); assert.equal(keys(h).length, 1);
});

test('plain item numbers outside a menu stay terminal text; forged menu callbacks cannot refresh or select', async t => {
  const { h } = await setup(t, '$ '), b = bound(h);
  await h.bridge.handle(message('1', 'normal', b.topicId));
  assert.equal(inputs(h).at(-1).params.text, '1');
  const count = h.feishu.calls.filter(c => c.type === 'patch').length;
  await click(h, '1', { nonce: 'forged', openId: 'ou_denied' });
  assert.equal(h.feishu.calls.filter(c => c.type === 'patch').length, count);
});

test('a changed non-menu approval refreshes its screen card in place without sending stale keys', async t => {
  const { h, pane } = await setup(t, 'Allow reading fixture.txt? [y/n]'), b = bound(h);
  pane.visible = 'Allow running another command? [y/n]';
  await click(h, 'y'); assert.equal(keys(h).length, 0);
  assert.match(JSON.stringify(h.feishu.calls.findLast(c => c.type === 'patch' && c.id === b.cardId).card), /another command/);
});

test('an unnumbered permission list includes command context, and a moved cursor uses current positioning', async t => {
  const screen = 'Tool: bash\nnpm test\nAllow this command?\n❯ Yes\n  No\nEsc to cancel';
  const { h, pane } = await setup(t, screen);
  assert.match(bound(h).cardMenu.context, /npm test/);
  pane.visible = screen.replace('❯ Yes', '  Yes').replace('  No', '❯ No');
  await click(h, 'menu:select:0');
  assert.deepEqual(keys(h).map(c => c.params.keys), [['up', 'enter']]);
});

test('a typed list item still requires the duplicate-session confirmation before Enter', async t => {
  const screen = 'Resume session\n❯ Fixture session\n  4 seconds ago · HEAD\n  Second session\n  3 minutes ago · HEAD\nEsc to cancel';
  const { h } = await setup(t, screen), other = h.fake.create();
  Object.assign(other, { agent: 'claude', terminal_title_stripped: 'Fixture session' });
  await h.bridge.handle(message('1', 'choice-one', bound(h).topicId));
  assert.equal(keys(h).length, 0);
  h.advance(1000); await h.bridge.tick();
  await h.bridge.handle(message('1', 'choice-two', bound(h).topicId));
  assert.deepEqual(keys(h).map(c => c.params.keys), [['enter']]);
});

test('a stale tap reconciles an uncertain menu patch before updating that same card to the latest context', async t => {
  const { h, pane } = await setup(t), b = bound(h), patch = h.feishu.patch.bind(h.feishu);
  h.feishu.patch = async (id, card) => {
    if (id === b.menuCardId) throw new Error('lost patch acknowledgement');
    return patch(id, card);
  };
  pane.visible = screens.claude.replace('npm test -- --runInBand', 'npm test -- changed');
  h.advance(2000); await h.bridge.tick();
  const pending = bound(h).pendingMenuCard; assert.ok(pending);
  pane.visible = screens.claude.replace('npm test -- --runInBand', 'npm test -- latest');
  let reconciled = false;
  h.feishu.patch = async (id, card) => {
    if (id === b.menuCardId && JSON.stringify(card).includes('npm test -- changed')) {
      assert.deepEqual(card, pending.card); reconciled = true;
    }
    return patch(id, card);
  };
  await click(h, '1'); assert.equal(keys(h).length, 0); assert.ok(reconciled);
  assert.match(JSON.stringify(h.feishu.calls.findLast(c => c.type === 'patch' && c.id === b.menuCardId).card), /npm test -- latest/);
  assert.equal(bound(h).pendingMenuCard, null);
});

test('typed list numbers beyond the phone page use absolute indices without bypassing button checks', async t => {
  const screen = 'Select model\n❯ Model 0\n' + Array.from({ length: 12 }, (_, i) => `  Model ${i + 1}`).join('\n') + '\nEsc to cancel';
  const { h } = await setup(t, screen);
  await h.bridge.handle(message('12', 'choice-twelve', bound(h).topicId));
  assert.deepEqual(keys(h).map(c => c.params.keys), [[...Array(11).fill('down'), 'enter']]);
});

test('a non-menu approval changed during the final check sends no key', async t => {
  const { h, pane } = await setup(t, 'Allow reading fixture.txt? [y/n]');
  const request = h.bridge.herdr.request.bind(h.bridge.herdr);
  h.bridge.herdr.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'pane.list') pane.visible = 'Allow another action? [y/n]';
    return result;
  };
  await click(h, 'y'); assert.equal(keys(h).length, 0);
});

test('an unchanged approval remains actionable during a failed output patch, and its consumed nonce never revives', async t => {
  const initial = 'npm test\nAllow this command? [y/n]\n\nProgress: 0';
  const { h, pane } = await setup(t, initial), old = bound(h), patch = h.feishu.patch.bind(h.feishu);
  h.feishu.patch = async () => { throw Object.assign(new Error('offline'), { code: 'network_error' }); };
  pane.visible = initial.replace('Progress: 0', 'Progress: 1');
  h.advance(2000); await h.bridge.tick();
  assert.ok(bound(h).pendingCard);
  assert.equal(bound(h).nonce, old.nonce);
  await click(h, 'y'); assert.equal(keys(h).length, 1);
  const replay = { messageId: old.cardId, nonce: old.nonce };
  await click(h, 'y', replay); assert.equal(keys(h).length, 1);
  h.feishu.patch = patch; h.advance(2000); await h.bridge.tick(); await h.restart();
  await click(h, 'y', replay); assert.equal(keys(h).length, 1);
  assert.notEqual(bound(h).nonce, old.nonce);
});

for (const kind of ['new question', 'changed command']) test(`${kind} still invalidates a non-menu approval without sending a key`, async t => {
  const { h, pane } = await setup(t, kind === 'new question' ? 'Waiting for approval' : 'npm test\nAllow this command? [y/n]');
  pane.visible = kind === 'new question' ? 'Allow a new command? [y/n]' : 'npm run deploy\nAllow this command? [y/n]';
  await click(h, 'y'); assert.equal(keys(h).length, 0);
  assert.ok(h.feishu.calls.some(c => c.content === '菜单已变化，已更新卡片。'));
});
