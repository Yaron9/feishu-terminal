import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assistantCard, userCard, outputCard, screenCard, stripChrome } from '../src/render.js';

export const sampleCards = () => ({
  assistant: assistantCard('**修复**已完成。\n\n- 已检查消息同步。', ['🔧 Bash: 运行测试']),
  desktop: userCard('请检查卡片显示。'),
  live: screenCard({ paneId: 'pane', label: '项目 · Claude', topicId: 'topic', nonce: 'nonce', status: 'working', text: '╭────╮\n❯ \n正在检查消息同步\n✻ Worked for 2s\n╰────╯' }),
  blocked: screenCard({ paneId: 'pane', label: '项目 · Claude', topicId: 'topic', nonce: 'nonce', status: 'blocked', text: '允许执行这条命令吗？ [y/n]' }),
  shell: outputCard('$ pwd\n/home/project\n$ '),
  screen: outputCard('❯ prompt\n╰────╯', { full: true }),
});

test('card JSON matches the reviewed assistant, desktop, live, blocked, shell and screen snapshots', async () => {
  const expected = JSON.parse(await readFile(new URL('./fixtures/ft10-cards.json', import.meta.url), 'utf8'));
  assert.deepEqual(sampleCards(), expected);
});

test('cards bound Unicode and escaped worst-case payloads below 28 KB, with tail notes and collapsed tools', () => {
  for (const char of ['中', '🙂', '&', '<', '`', '\\', '"']) {
    const text = char.repeat(100000);
    const cards = [assistantCard(text, Array(1000).fill('🔧 Bash: ' + text)), userCard(text), outputCard(text), outputCard(text, { full: true }),
      screenCard({ paneId: 'pane', topicId: 'topic', nonce: 'nonce', text: Array(100).fill(text).join('\n') })];
    assert.ok(cards.every(card => Buffer.byteLength(JSON.stringify(card)) < 28000), char);
    assert.match(cards[0].body.elements[0].content, /仅显示末尾/);
    assert.equal(cards[0].body.elements[1].expanded, false);
    assert.equal(Array.from(cards[1].body.elements[0].content.replace(/^<font[^>]*>[^<]*<\/font>\n\n/, '')).length <= 1500 * 5, true);
    assert.ok(!JSON.stringify(cards).includes('\ufffd'));
  }
});

test('live preview strips frames, prompts, spinner/status chrome and stays at ten lines; mentions stay escaped', () => {
  const text = '╭─────╮\n│ reply │\n╰─────╯\n❯ desktop prompt\n❯ \n✻ Worked for 2s\n⠋ Thinking\n' + Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const stripped = stripChrome(text); assert.match(stripped, /^reply\nline 0/);
  assert.ok(!/❯|Thinking|Worked for|─/.test(stripped));
  const card = screenCard({ paneId: 'pane', topicId: 'topic', nonce: 'nonce', text, status: 'idle' });
  const lines = card.elements[0].content.split('```')[1].slice(5).trimEnd().split('\n'); assert.equal(lines.length, 10);
  assert.equal(lines[0], 'line 10'); assert.equal(lines.at(-1), 'line 19');
  assert.match(card.header.title.content, /🤖 Claude · 空闲/);
  assert.ok(!JSON.stringify(assistantCard('<at id=all>all</at>')).includes('<at'));
  assert.ok(!JSON.stringify(userCard('<at id=all>all</at>')).includes('<at'));
});
