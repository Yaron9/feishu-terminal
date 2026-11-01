import test from 'node:test';
import assert from 'node:assert/strict';
import { newOutput, splitText, screenText, screenCard, clean } from '../src/render.js';

test('diff handles appends, rolling scrollback, partial lines, rewrites and unchanged revisions', () => {
  for (const [before, after, expected] of [
    ['', 'a\n', 'a\n'], ['a\n', 'a\nb\n', 'b\n'], ['a\nb\n', 'b\nc\n', 'c\n'],
    ['a\npar', 'a\npartial', 'tial'], ['progress 1%', 'progress 2%', '2%'],
    ['same', 'same', ''], ['a', '', ''], ['old', 'new', 'new'], ['🙂a', 'a🙂b', '🙂b'],
  ]) assert.equal(newOutput(before, after), expected);
});
test('split retains every Unicode character, newline and space under UTF-8 byte ceiling', () => {
  const text = (' 中文🙂\n a  \n' + 'x'.repeat(333)).repeat(80);
  const parts = splitText(text, 109);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 109 && !p.includes('\ufffd')));
  assert.deepEqual(splitText(''), []);
  assert.throws(() => splitText('a', 3));
});
test('screen clamps rows and width, strips controls, escapes markup, and exposes explicit blocked buttons', () => {
  const text = Array.from({ length: 50 }, (_, i) => `${i}:` + '中'.repeat(150)).join('\n');
  const result = screenText(text);
  assert.ok(result.startsWith('[earlier rows omitted]\n10:'));
  assert.equal(result.split('\n').length, 41);
  assert.ok(result.includes('[width truncated]'));
  assert.equal(clean('\x1b[31mred\x1b[0m\r\n\x07x'), 'red\nx');
  const card = screenCard({ paneId: 'w1:p1', topicId: 'm1', nonce: 'nonce', status: 'blocked', text: '<at id=all>```' });
  assert.ok(card.elements[0].content.includes('&lt;at'));
  assert.ok(card.elements[0].content.includes('`\u200b'));
  const buttons = card.elements.slice(1).flatMap(e => e.actions);
  assert.deepEqual(buttons.map(b => b.text.content), ['Enter', 'Esc', '1', '2', '3', 'y', 'n', 'Ctrl-C', 'Refresh']);
  assert.ok(buttons.every(b => b.value.topic_id === 'm1' && b.value.nonce === 'nonce'));
  assert.equal(screenCard({ paneId: 'x', topicId: 'y', nonce: 'z', text: '', status: 'idle' }).elements.length, 1);
});
