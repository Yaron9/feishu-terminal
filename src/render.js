import { stripVTControlCharacters } from 'node:util';

export function clean(text) {
  return stripVTControlCharacters(String(text)).replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function screenText(text, rows = 40, width = 120) {
  const all = clean(text).split('\n');
  const visible = all.slice(-rows).map(line => {
    const chars = Array.from(line);
    return chars.length > width ? chars.slice(0, width).join('') + ' … [width truncated]' : line;
  });
  if (all.length > rows) visible.unshift('[earlier rows omitted]');
  return visible.join('\n');
}

// Rolling snapshots overlap by suffix/prefix. A revised last line contributes
// only its new suffix; a rewritten screen contributes the changed tail.
export function newOutput(previous = '', current = '') {
  if (current === previous) return '';
  previous = Array.from(previous); current = Array.from(current);
  // KMP finds the longest old suffix that is a new prefix in linear time.
  const prefix = new Uint32Array(current.length);
  for (let i = 1, j = 0; i < current.length; i++) {
    while (j && current[i] !== current[j]) j = prefix[j - 1];
    if (current[i] === current[j]) j++;
    prefix[i] = j;
  }
  let overlap = 0;
  for (const char of previous) {
    while (overlap && (overlap === current.length || char !== current[overlap])) overlap = prefix[overlap - 1];
    if (char === current[overlap]) overlap++;
  }
  if (overlap) return current.slice(overlap).join('');
  let common = 0;
  while (common < previous.length && common < current.length && previous[common] === current[common]) common++;
  return current.slice(common).join('');
}

// Bound UTF-8 bytes, never split a Unicode code point or trim any characters.
export function splitText(text, maxBytes = 12000) {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error('maxBytes must be at least 4');
  const parts = []; let part = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) { parts.push(part); part = ''; bytes = 0; }
    part += char; bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

const BUTTONS = [['Enter', 'enter'], ['Esc', 'esc'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['Ctrl-C', 'ctrl+c'], ['Refresh', 'refresh']];

export function screenCard({ paneId, label = paneId, topicId, nonce, status = 'unknown', text }) {
  // Escaped HTML avoids terminal output creating mentions/card markup. The
  // zero-width separator prevents terminal backticks ending the code fence.
  const code = screenText(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, '`\u200b');
  const elements = [{ tag: 'markdown', content: '```text\n' + code + '\n```' }];
  if (status === 'blocked') {
    for (let i = 0; i < BUTTONS.length; i += 3) elements.push({
      tag: 'action', actions: BUTTONS.slice(i, i + 3).map(([label, key]) => ({
        tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default',
        value: { topic_id: topicId, nonce, key },
      })),
    });
  }
  return { config: { wide_screen_mode: true, update_multi: true }, header: { template: status === 'blocked' ? 'orange' : 'blue', title: { tag: 'plain_text', content: label } }, elements };
}
