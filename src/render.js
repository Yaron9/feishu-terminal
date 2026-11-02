import { stripVTControlCharacters } from 'node:util';

export function clean(text) {
  return stripVTControlCharacters(String(text)).replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function stripChrome(text) {
  return clean(text).split('\n').filter(line => {
    const value = line.trim();
    return !(/^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝+\-]{3,}$/.test(value) ||
      /^[❯›](?:\s|$)/.test(value) || /^[>\$]\s*$/.test(value) ||
      /^[✻✽✶✳✢·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/.test(value) ||
      /^(?:Worked for|Thinking|Brewing|Cogitating|Churning|Wandering|Esc to interrupt|ctrl\+c to interrupt)\b/i.test(value));
  }).map(line => line.replace(/^\s*[│┃║]\s?/, '').replace(/\s*[│┃║]\s*$/, '')).join('\n').trimEnd();
}

const tail = (text, count) => Array.from(text).slice(-count).join('');
const markup = text => clean(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const codeBlock = text => '```text\n' + markup(text).replace(/`/g, '`\u200b') + '\n```';
const markdown = content => ({ tag: 'markdown', content });
const roleCard = (title, template, elements) => ({ schema: '2.0', config: { update_multi: true },
  header: { template, title: { tag: 'plain_text', content: title } }, body: { elements } });

export function assistantCard(text, tools = [], agent = 'Claude') {
  text = clean(text);
  const clipped = Array.from(text).length > 1500;
  const elements = [markdown((clipped ? '（仅显示末尾）\n\n' : '') + markup(tail(text, 1500) || '（工具调用）'))];
  if (tools.length) elements.push({ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: `🔧 工具调用 (${tools.length})` } },
    elements: [markdown(markup(tail(tools.map(t => String(t).replace(/\s+/g, ' ').slice(0, 140)).join('\n'), 1500)))] });
  return roleCard(`🤖 ${String(agent).slice(0, 40)}`, 'blue', elements);
}

export function userCard(text) {
  const clipped = Array.from(text).length > 1500;
  return roleCard('🧑 电脑端输入', 'grey', [markdown((clipped ? '（仅显示末尾）\n\n' : '') + markup(tail(text, 1500)))]);
}

export function outputCard(text, { full = false } = {}) {
  const content = full ? clean(text) : stripChrome(text);
  const lines = content.split('\n'), limit = full ? Infinity : 60;
  const body = tail(lines.slice(-limit).join('\n'), full ? 4000 : 3000);
  return roleCard(full ? '💻 当前屏幕' : '💻 输出', 'grey',
    [markdown((lines.length > limit || body.length < content.length ? '（仅显示末尾）\n' : '') + codeBlock(body))]);
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

export function pickerCard(card, result) {
  result ??= card.result;
  const elements = [];
  const text = content => ({ tag: 'div', text: { tag: 'plain_text', content } });
  const buttons = (items, index) => ({ tag: 'action', actions: items.map(([label, action]) => ({
    tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default',
    value: { topic_id: card.topicId, nonce: card.nonce, key: `picker:${action}:${index}` },
  })) });
  if (result && typeof result === 'object') card.entries.forEach((entry, index) => {
    elements.push(text(index === result.index ? result.text : entry.label));
    if (card.kind === 'recovered' && index === result.index) elements.push(buttons([['移到新话题', 'move']], index));
  });
  else if (result) elements.push(text(result));
  else card.entries.forEach((entry, index) => {
    const label = entry.label + (entry.topicDescription ? `\n${entry.label.includes('已冻结') ? '话题' : '已绑定话题'}${entry.topicDescription}` : '');
    elements.push(text(card.kind === 'confirm' ? `确定关闭「${entry.label}」？里面的会话会结束` : label));
    elements.push(buttons(card.kind === 'list' ? [['打开', 'open'], ['关闭', 'close'], ...(entry.canMove ? [['移到新话题', 'move']] : [])] :
      card.kind === 'confirm' ? [['确定关闭', 'kill'], ['取消', 'cancel']] :
        [['仅解绑', 'unbind'], ['关闭终端', 'kill'], ['取消', 'cancel']], index));
  });
  if (!elements.length) elements.push(text('暂无终端'));
  return { config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: ['list', 'recovered'].includes(card.kind) ? '选择终端' : '关闭终端' } }, elements };
}

export function screenCard({ paneId, label = paneId, topicId, nonce, status = 'unknown', text, note }) {
  // Escaped HTML avoids terminal output creating mentions/card markup. The
  // zero-width separator prevents terminal backticks ending the code fence.
  const preview = stripChrome(text).split('\n').filter(line => line.trim()).slice(-10).join('\n');
  const elements = [markdown(codeBlock(screenText(preview, 10)))];
  if (note) elements.unshift({ tag: 'div', text: { tag: 'plain_text', content: note } });
  if (status === 'blocked') {
    for (let i = 0; i < BUTTONS.length; i += 3) elements.push({
      tag: 'action', actions: BUTTONS.slice(i, i + 3).map(([label, key]) => ({
        tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default',
        value: { topic_id: topicId, nonce, key },
      })),
    });
  }
  const activity = { working: '工作中', idle: '空闲', done: '空闲', blocked: '等待确认' }[status] ?? '状态未知';
  return { config: { wide_screen_mode: true, update_multi: true }, header: { template: status === 'blocked' ? 'orange' : 'blue',
    title: { tag: 'plain_text', content: `● ${activity} · ${Array.from(label).slice(0, 180).join('')}` } }, elements };
}
