import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { allCards } from './fixtures/ft16-samples.js';
import { screenControls, stripChrome, outputCard, screenCard, turnCard } from '../src/render.js';
import { HELP } from '../src/router.js';
import { WELCOME } from '../src/setup.js';
import { legacyHarness as harness, message } from './helpers.js';

const buttons = card => {
  if (!card || typeof card !== 'object') return [];
  return (card.behaviors?.[0]?.type === 'callback' ? [{ ...card, value: card.behaviors[0].value, text: card.text ?? { content: card.elements?.[0]?.content ?? '' } }] : card.tag === 'button' ? [card] : []).concat(Object.values(card).flatMap(value =>
    Array.isArray(value) ? value.flatMap(buttons) : value && typeof value === 'object' ? buttons(value) : []));
};

test('every card type and state matches the Chinese copy snapshot and remains below 28 KB', async () => {
  const expected = JSON.parse(await readFile(new URL('./fixtures/ft16-cards.json', import.meta.url), 'utf8'));
  assert.deepEqual(allCards(), expected);
  for (const [name, card] of Object.entries(allCards())) {
    assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000, name);
    assert.match(JSON.stringify(card), /[\u4e00-\u9fff]/u, name);
  }
});

test('Enter only appears on an explicit unnumbered prompt; number buttons carry the actual option text', () => {
  for (const text of ['等待你确认', '允许执行吗？', '输入命令，Enter 是回车键']) assert.ok(!screenControls(text).some(b => b[1] === 'enter'));
  for (const text of ['Press Enter to continue', 'Enter to confirm', '请按回车继续', '按下 Enter 继续', '↵']) {
    assert.deepEqual(screenControls(text)[0], ['Enter 继续', 'enter']);
  }
  const menu = '是否执行？\n❯ 1. 是，执行\n  2) 始终允许\n  3、否，取消\nPress Enter to confirm';
  const options = screenControls(menu);
  assert.ok(!options.some(b => b[1] === 'enter'));
  assert.deepEqual(options.filter(b => /^\d$/.test(b[1])), [['1 是，执行', '1'], ['2 始终允许', '2'], ['3 否，取消', '3']]);
  const card = turnCard({ turn: { agent: 'Claude', text: '等待工具授权', status: 'blocked' }, screen: menu, topicId: 'topic', nonce: 'nonce' });
  assert.match(JSON.stringify(card), /是否执行？/);
  assert.ok(!buttons(card).some(b => b.value.key === 'enter'));
});

test('numbered menu clicks send a single key without Enter, and the terminal menu settles on that key', async t => {
  for (const key of ['1', '2', '3']) {
    const h = await harness(t);
    await h.bridge.handle(message('claude'));
    const pane = h.fake.panes.get('w1:p1');
    Object.assign(pane, { agent: 'claude', agent_status: 'blocked', visible: '是否执行？\n❯ 1. 是，执行\n  2. 始终允许\n  3. 否，取消' });
    await h.bridge.tick();
    const binding = h.store.forPane(pane.pane_id);
    const card = h.feishu.calls.findLast(c => c.msgType === 'interactive').content;
    const button = buttons(card).find(b => b.value.key === key);
    assert.ok(button, key);
    const original = h.bridge.herdr.request.bind(h.bridge.herdr);
    let selected;
    h.bridge.herdr.request = async (method, params) => {
      const result = await original(method, params);
      // Model the Claude menu contract: a digit alone selects and confirms.
      if (method === 'pane.send_keys') {
        assert.deepEqual(params.keys, [key]);
        selected = params.keys[0]; pane.agent_status = 'working'; pane.visible = '已选择，继续处理';
      }
      return result;
    };
    const before = h.fake.calls.length;
    await h.bridge.handle({ kind: 'button', eventId: randomUUID(), chatId: binding.chatId, topicId: binding.topicId,
      messageId: binding.menuCardId, openId: 'ou_test', ...button.value, topicId: button.value.topic_id });
    assert.equal(selected, key);
    const writes = h.fake.calls.slice(before).filter(c => ['pane.send_text', 'pane.send_keys', 'agent.prompt'].includes(c.method));
    assert.deepEqual(writes.map(c => c.params.keys), [[key]]);
    assert.equal(h.bridge.state(binding).status, 'working');
  }
});

test('a separate permission menu card updates its prompt and option labels when only the screen changes', async t => {
  const records = [];
  const adapter = { locate: async () => 'copy.jsonl', read: async (_path, cursor) => ({ cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset) }) };
  const h = await harness(t, { adapters: { claude: adapter } });
  const pane = h.fake.create(); Object.assign(pane, { agent: 'claude', agent_status: 'blocked', visible: '第一次确认？\n1. 执行' });
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  records.push({ role: 'assistant', text: '请授权操作' }); await h.bridge.tick();
  const id = h.store.forPane(pane.pane_id).menuCardId;
  pane.visible = '第二次确认？\n1. 继续检查\n2. 停止'; h.advance(2000);
  h.bridge.state(h.store.forPane(pane.pane_id)).dirty = true; await h.bridge.tick();
  const card = h.feishu.calls.findLast(c => c.type === 'patch' && c.id === id).card;
  assert.match(JSON.stringify(card), /第二次确认？/);
  assert.match(buttons(card).find(b => b.value.key === '1').text.content, /继续检查/);
  assert.match(buttons(card).find(b => b.value.key === '2').text.content, /停止/);
});

test('both phone guides explain starting, replying, listing, closing, moving and button meanings in Chinese', () => {
  for (const guide of [HELP, WELCOME]) for (const fragment of ['claude', 'cd ~/proj && claude', '话题内回复', '/t ls', '仅解绑', '关闭终端', '移到新话题', 'Esc 取消', 'y 同意', 'n 拒绝', 'Ctrl-C 中断', 'Enter 继续', '/t k enter']) assert.ok(guide.includes(fragment), fragment);
});

test('preview decoration threshold covers blocks, boxes and braille while preserving ordinary Unicode text', () => {
  assert.equal(stripChrome('██a\n┌─a\n⣿⣿a\n█a\n中文🙂说明'), '█a\n中文🙂说明');
  const raw = '\x1b[31m错误：磁盘空间不足\x1b[0m\n红色终端输出';
  assert.ok(!JSON.stringify(outputCard(raw)).includes('\\u001b'));
  assert.match(JSON.stringify(turnCard({ turn: { agent: 'Claude', text: raw, status: 'error' } })), /<font color='red'>错误：磁盘空间不足<\/font>/);
  assert.equal(screenCard({ text: '任务完成', status: 'done', agent: 'claude' }).header.template, 'green');
});

test('real Claude banner and compact quadrant fixture disappear from previews but stay intact in /t screen', async () => {
  for (const name of ['claude-banner-real.txt', 'claude-banner-quadrant.txt']) {
    const banner = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const raw = banner + '\n这是需要保留的实际回复。';
    const preview = stripChrome(raw);
    assert.ok(!/[\u2500-\u259f\u2800-\u28ff]/u.test(preview), name);
    assert.ok(!/Claude Code v|Sonnet 4\.5|Claude Pro/.test(preview), name);
    for (const card of [outputCard(raw), screenCard({ text: raw }), turnCard({ turn: { agent: 'Claude', text: raw, settled: true } })]) {
      assert.match(JSON.stringify(card), /这是需要保留的实际回复/);
      assert.ok(!/[\u2500-\u259f\u2800-\u28ff]/u.test(JSON.stringify(card)), name);
    }
    assert.ok(outputCard(raw, { full: true }).body.elements[0].content.includes(banner.trimEnd()));
  }
});
