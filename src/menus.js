import { stripVTControlCharacters } from './ansi.js';
import { lookupCli } from './cli-table.js';

const hint = /(?:esc(?:ape)?\s+to\s+(?:cancel|close|exit|go back)|[↑↓]\s*(?:\/|\s)*[↑↓]|(?:enter|↵)\s+to\s+(?:select|confirm|choose)|to\s+navigate|arrow keys|方向键|上下键|按.*Esc.*取消)/i;
const titleHint = /(?:resume\s+session|select\s+(?:a\s+)?(?:model|session|option)|choose|settings|configuration|config|permission|allow|confirm|proceed|do you|would you|选择|设置|恢复会话|是否|确认|允许)/i;
const chrome = value => !value || /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝+\-]+$/u.test(value) || /[⌕🔍]|search…|search\.\.\./i.test(value);
const numbered = line => /^\s*(?:[❯›>│┃║]\s*)?([1-9])[.)、．）]\s*(\S.*)$/u.exec(line);
const empty = () => ({ kind: null, title: '', items: [], cursorIndex: -1 });
const unbox = line => line.replace(/^\s*[│┃║]\s?|\s*[│┃║]\s*$/gu, '').trimEnd();

function contextAbove(lines, question) {
  const context = []; let index = question - 1;
  while (index >= 0 && !unbox(lines[index]).trim()) index--;
  for (; index >= 0 && context.length < 12; index--) {
    const value = unbox(lines[index]);
    if (chrome(value.trim())) break;
    context.unshift(value);
  }
  // Permission headings often occupy their own block above the command.
  if (index >= 1 && !lines[index].trim() && /^(?:Bash command|Shell command|Command|File|Tool|Permission)\b/i.test(unbox(lines[index - 1]).trim()))
    context.unshift(unbox(lines[index - 1]));
  const text = context.slice(-12).map(line => Array.from(line).slice(0, 300).join('')).join('\n').trim();
  return text ? { context: text } : {};
}

// Status/output churn is not proof that a different approval is on screen.
// Only a recognizable question and its command context can establish that.
export function approvalContext(text = '') {
  const lines = stripVTControlCharacters(String(text ?? '')).replace(/\r/g, '').split('\n');
  const index = lines.findLastIndex(line => !hint.test(line) &&
    /[?？]|\b(?:permission|allow|confirm|proceed)\b|\[(?:y\/n|yes\/no)\]|enter to continue|是否|确认|允许/i.test(line));
  if (index < 0) return null;
  return [contextAbove(lines, index).context, unbox(lines[index]).trim()].filter(Boolean).join('\n');
}

// Use the visible screen, before preview/chrome removal. All offsets are text
// columns in that snapshot, not tmux coordinates or transcript line numbers.
export function detectMenu(text = '', { status, cli } = {}) {
  const rawLines = String(text).replace(/\r/g, '').split('\n');
  const lines = rawLines.map(line => stripVTControlCharacters(line).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
  const hintIndex = lines.findLastIndex(line => hint.test(line));
  // A footer above a new prompt belongs to history. Only the bottom live
  // control region can own choices; question punctuation is never evidence.
  const last = lines.findLastIndex(line => !chrome(line.trim()));
  const footer = hintIndex >= 0 && lines.slice(hintIndex + 1).every(line => chrome(line.trim()) || hint.test(line));
  if (hintIndex >= 0 && !footer) return empty();
  const tableMenu = lookupCli({ agent: cli })?.menuScreen?.(lines.join('\n')) ?? false;
  if (status !== undefined && !['blocked', 'waiting'].includes(status) && !tableMenu) return empty();
  const end = footer ? hintIndex : last + 1;
  let bottom = end - 1;
  while (bottom >= 0 && chrome(lines[bottom].trim())) bottom--;
  const numberRows = [];
  for (let i = bottom; i >= 0; i--) {
    const match = numbered(lines[i]);
    if (match) numberRows.unshift({ match, index: i });
    else if (lines[i].trim()) break;
  }
  if (numberRows.length && numberRows.every((row, i) => Number(row.match[1]) === i + 1)) {
    const titleIndex = lines.slice(0, numberRows[0].index).findLastIndex(line => !chrome(unbox(line).trim()));
    const title = titleIndex >= 0 ? unbox(lines[titleIndex]).trim() : '';
    const cursor = numberRows.some(row => /^\s*[❯›>]/u.test(lines[row.index]));
    const approval = /permission|allow|confirm|proceed|do you want|would you like|是否|确认|允许/i.test(title);
    if ((cursor || footer) && (approval || (cursor && titleHint.test(title)))) {
      return { kind: 'numbered', title, ...contextAbove(lines, titleIndex), items: numberRows.map(row => ({ label: row.match[2].replace(/\s*[│┃║]\s*$/u, '').trim(), sublabel: '' })),
        cursorIndex: numberRows.findIndex(row => /^\s*[❯›>]/u.test(lines[row.index])) };
    }
  }
  if (hintIndex < 0) return empty();
  const cursors = lines.slice(0, hintIndex).flatMap((line, index) => {
    const match = /^(\s*)[❯›>] (\S.*)$/u.exec(line);
    return match ? [{ index, column: match[1].length + 2, label: match[2].trim() }] : [];
  });
  const cursor = cursors.at(-1);
  const titleIndex = lines.slice(0, cursor?.index ?? hintIndex).findLastIndex(line => titleHint.test(line) &&
    !hint.test(line) && !chrome(line.trim()) && line.search(/\S/u) < (cursor?.column ?? Infinity));
  const namedTitle = lines[titleIndex];
  if (!cursor) return namedTitle ? { kind: 'list', title: namedTitle.trim(), items: [], cursorIndex: -1 } : empty();
  const column = cursor.column;
  let start = cursor.index;
  // The first less-indented row / search box bounds the item area.
  while (start > 0) {
    const line = lines[start - 1], value = line.trim();
    if (value && (chrome(value) || line.search(/\S/u) < column)) break;
    start--;
  }
  const title = namedTitle?.trim() ?? lines.slice(0, start).filter(line => !chrome(line.trim()) && !hint.test(line)).at(-1)?.trim() ?? '';
  const resume = /resume\s+session|恢复会话/i.test(title);
  const items = []; let cursorIndex = -1, reliable = !namedTitle || cursors.filter(row => row.index > titleIndex).length === 1;
  for (let i = start; i < hintIndex; i++) {
    const line = lines[i], value = line.trim();
    if (!value) continue;
    if (chrome(value)) continue;
    const selected = i === cursor.index;
    const indent = line.search(/\S/u);
    if (!selected && indent < column) break;
    const dim = /\x1b\[(?:\d+;)*(?:2|90)(?:;\d+)*m/.test(rawLines[i]);
    if (!selected && dim && items.length && lines[i - 1]?.trim()) {
      items.at(-1).sublabel += (items.at(-1).sublabel ? '\n' : '') + value;
      continue;
    }
    if (!selected && indent > column) {
      if (items.length) items.at(-1).sublabel += (items.at(-1).sublabel ? '\n' : '') + value;
      continue;
    }
    if (!selected && /^[❯›>]/u.test(value)) { reliable = false; continue; }
    // Resume groups (e.g. "ubuntu") share the item column, but have no
    // timestamp/detail row. They are headings, not selectable sessions.
    const next = lines[i + 1]?.trim() ?? '';
    const detail = /(?:ago|yesterday|today|seconds?|minutes?|hours?|days?|刚刚|分钟前|小时前|天前|\bHEAD\b|\d.*(?:KB|MB|GB))/i.test(next);
    if (resume && !detail) { if (selected) reliable = false; continue; }
    if (selected) cursorIndex = items.length;
    items.push({ label: selected ? cursor.label : value, sublabel: '' });
    if (resume && detail) { items.at(-1).sublabel = next; i++; }
  }
  if (!items.length || cursorIndex < 0 || (items.length === 1 && !namedTitle)) reliable = false;
  // An ordinary > quote without a menu title and siblings is not a menu.
  if (!namedTitle && !reliable) return empty();
  return { kind: 'list', title, ...(titleIndex >= 0 ? contextAbove(lines, titleIndex) : {}), items: reliable ? items : [], cursorIndex: reliable ? cursorIndex : -1 };
}

export const sameMenu = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const sameMenuChoices = (a, b) => JSON.stringify(a && [a.kind, a.title, a.context ?? '', a.items.map(item => item.label)]) ===
  JSON.stringify(b && [b.kind, b.title, b.context ?? '', b.items.map(item => item.label)]);

export function resumeWarnings(menu, panes, paneId, screen = '') {
  if (menu?.kind !== 'list' || !/resume\s+session|恢复会话/i.test(menu.title)) return {};
  // Even if details cannot be parsed into a reliable list, a raw cursor label
  // can reveal a duplicate. Guard fallback Enter conservatively in that case.
  const fallbackLabels = stripVTControlCharacters(screen).split('\n').flatMap(line => {
    const match = /^\s*[❯›>] (\S.*)$/u.exec(line);
    return match ? [match[1].trim()] : [];
  });
  return Object.fromEntries((menu.items.length ? menu.items : [{ label: null }]).flatMap((item, index) => {
    const matches = panes.filter(pane => pane.pane_id !== paneId && /^claude$/i.test(pane.agent ?? '') &&
      pane.terminal_id && (item.label === null ? fallbackLabels.includes(String(pane.terminal_title_stripped ?? '').trim()) :
        String(pane.terminal_title_stripped ?? '').trim() === item.label));
    return matches.length ? [[index, matches.map(pane => ({ paneId: pane.pane_id, terminalId: pane.terminal_id,
      label: `${pane.pane_id} · ${String(pane.terminal_title_stripped).trim()}` }))]] : [];
  }));
}

const warningLabel = warnings => warnings?.length ? `⚠️ 已在 ${Array.from(warnings[0].label).slice(0, 30).join('')}${warnings.length > 1 ? ` 等 ${warnings.length} 个终端` : ''} 运行` : null;

// Conservative serialized row budget includes escaped Markdown, callback metadata
// and layout. Reduce the whole page, never a session title.
export function menuPageSize(menu, warnings = {}) {
  const budget = Math.max(1000, 20000 - Buffer.byteLength(JSON.stringify(menu.context ?? '').replace(/[&<>\\`*_\[\]~!]/g, 'xxxxxx')));
  const costs = menu.items.map((item, index) => 900 + Buffer.byteLength(JSON.stringify(
    [item.label, item.sublabel, warnings[index] ?? []]).replace(/[&<>\\`*_\[\]~!]/g, 'xxxxxx')));
  for (let size = 10; size > 1; size--) {
    if (costs.every((_, i) => i % size || costs.slice(i, i + size).reduce((a, b) => a + b, 0) < budget)) return size;
  }
  return 1;
}

export function menuControls(menu, { page = 0, warnings = {}, confirm, pageSize = menuPageSize(menu, warnings) } = {}) {
  if (confirm && sameMenu(confirm.menu, menu)) return [
    [`确定恢复 ${menu.items[confirm.index]?.label ?? '当前会话'}`, `menu:confirm:${confirm.index}`],
    ['返回菜单', 'menu:back'], ['Esc 取消', 'esc'], ['刷新', 'refresh'],
  ];
  const buttons = [];
  if (menu.items.length) {
    const offset = (page % Math.ceil(menu.items.length / pageSize)) * pageSize;
    menu.items.slice(offset, offset + pageSize).forEach((item, i) => {
      const index = offset + i;
      buttons.push([warningLabel(warnings[index]) ?? item.label, `menu:select:${index}`]);
    });
    if (menu.items.length > pageSize) buttons.push(['更多…', 'menu:more']);
  }
  if (!menu.items.length || menu.items.length > pageSize) buttons.push(['↑ 上一个', 'up'], ['↓ 下一个', 'down']);
  if (!menu.items.length) buttons.push([warningLabel(warnings[0]) ?? 'Enter 选中', 'enter']);
  return [...buttons, ['Esc 取消', 'esc'], ['刷新', 'refresh']];
}
