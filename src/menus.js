import { stripVTControlCharacters } from './ansi.js';
import { lookupCli } from './cli-table.js';

const hint = /(?:esc(?:ape)?\s+to\s+(?:cancel|close|exit|go back)|[↑↓]\s*(?:\/|\s)*[↑↓]|[↑↓].*\bbrowse\b|(?:enter|↵)\s+to\s+(?:select|confirm|choose)|\benter\s+(?:to\s+)?\w+.*\besc(?:ape)?\s+(?:to\s+)?\w+|to\s+navigate|arrow keys|方向键|上下键|按.*Esc.*取消)/i;
const titleHint = /(?:resume\s+session|select\s+(?:a\s+)?(?:model|session|option)|choose|settings|configuration|config|permission|allow|confirm|proceed|do you|would you|选择|设置|恢复会话|是否|确认|允许)/i;
const chrome = value => !value || /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝+\-↑↓]+$/u.test(value) || /[⌕🔍]|search…|search\.\.\./i.test(value);
const numbered = line => /^\s*(?:[❯›>│┃║]\s*)?([1-9])[.)、．）]\s*(\S.*)$/u.exec(line);
// Claude's rating survey puts every option on one row at the idle prompt:
// `1: Bad    2: Fine   3: Good   0: Dismiss`. Keys are printed per option, so
// they need not start at 1 and may include 0.
const inlineRow = line => {
  const parts = line.trim().split(/\s{2,}/);
  if (parts.length < 2) return null;
  const items = [];
  for (const part of parts) {
    const match = /^(\d)[:：.．、）)]\s*(\S.*?)\s*$/u.exec(part.trim());
    const label = match?.[2]?.replace(/[|｜]+$/, '').trim();
    if (!label || Array.from(label).length > 24 || /\s{2,}/u.test(label)) return null;
    items.push({ key: match[1], label });
  }
  return new Set(items.map(item => item.key)).size === items.length ? items : null;
};
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

// A rating prompt asks at an idle pane, where herdr never reports a blocked
// terminal. The question mark and the option row are the proof, and they must
// sit at the bottom of the screen: the same row in scrollback is history. Only
// the input box and the status line may follow it.
function surveyMenu(lines, last) {
  const row = lines.findLastIndex(line => inlineRow(line));
  if (row < 0 || row > last || last - row > 4) return null;
  for (const line of lines.slice(row + 1, last + 1)) {
    const value = unbox(line).trim();
    if (!value || chrome(value) || /^[❯›>→]\s*/.test(value) || /[?？]/.test(value) || numbered(value)) continue;
    return null;
  }
  let index = row - 1;
  while (index >= 0 && chrome(unbox(lines[index]).trim())) index--;
  const title = index >= 0 ? unbox(lines[index]).trim() : '';
  if (!/[?？]/.test(title)) return null;
  const items = inlineRow(lines[row]).map(item => ({ label: item.label, sublabel: '', key: item.key }));
  const dismiss = items.find(item => /dismiss|skip|later|忽略|跳过|稍后|取消/i.test(item.label)) ??
    items.find(item => item.key === '0');
  return { kind: 'numbered', title: title.replace(/^[●•*]\s*/, ''), ...contextAbove(lines, index),
    items, cursorIndex: -1, dismissKey: dismiss?.key ?? null };
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
  // Pi draws the picker between horizontal rules, above its persistent status.
  if (cli === 'pi') {
    const parts = String(text).replace(/\r/g, '').split('\n');
    const rules = parts.flatMap((line, i) => /^─{10,}\s*$/u.test(line.trim()) ? [i] : []);
    if (rules.length >= 2) {
      const live = parts.slice(rules.at(-2) + 1, rules.at(-1));
      if (live.some(line => /^Resume Session \(/.test(line)) && live.some(line => /^›\s+\S/.test(line))) live.push('enter select · esc exit');
      if (live.some(line => /Enter to select.*Escape\/Ctrl\+C to cancel/i.test(line))) live.push('enter select · esc exit');
      if (live.some(line => hint.test(line))) text = live.join('\n');
    }
  }
  const rawLines = String(text).replace(/\r/g, '').split('\n');
  const lines = rawLines.map(line => stripVTControlCharacters(line).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
  const hintIndex = lines.findLastIndex(line => hint.test(line));
  // A footer above a new prompt belongs to history. Only the bottom live
  // control region can own choices; question punctuation is never evidence.
  const last = lines.findLastIndex(line => !chrome(line.trim()));
  if (status !== 'working') {
    const survey = surveyMenu(lines, last);
    if (survey) return survey;
  }
  const footer = hintIndex >= 0 && lines.slice(hintIndex + 1).every(line => chrome(line.trim()) || hint.test(line));
  if (hintIndex >= 0 && !footer) return empty();
  const updateMenu = footer && /enter\s+continue\s*·\s*esc\s+skip/i.test(lines[hintIndex]) &&
    lines.some(line => /^\s*Update available\s*·/i.test(line));
  const tableMenu = updateMenu || (lookupCli({ agent: cli })?.menuScreen?.(lines.join('\n')) ?? false);
  let end = footer ? hintIndex : last + 1;
  while (end > 0 && hint.test(lines[end - 1])) end--;
  let bottom = end - 1;
  while (bottom >= 0 && chrome(lines[bottom].trim())) bottom--;
  const numberRows = [];
  for (let i = bottom; i >= 0; i--) {
    const match = numbered(lines[i]);
    if (match) numberRows.unshift({ match, index: i });
    else if (lines[i].trim()) break;
  }
  const numberedRows = numberRows.length > 0 && numberRows.every((row, i) => Number(row.match[1]) === i + 1);
  const askTitleIndex = numberedRows ? lines.slice(0, numberRows[0].index).findLastIndex(line => !chrome(unbox(line).trim())) : -1;
  const askTitle = askTitleIndex >= 0 ? unbox(lines[askTitleIndex]).trim() : '';
  const approval = /permission|allow|confirm|proceed|do you want|would you like|是否|确认|允许/i.test(askTitle);
  // A prompt that spells out its question and its numbered choices is a menu
  // even when the pane still reads idle: the screen itself is the evidence.
  if (status !== undefined && !['blocked', 'waiting'].includes(status) && !tableMenu &&
      !(approval && numberedRows && status !== 'working')) return empty();
  if (numberedRows) {
    const cursor = numberRows.some(row => /^\s*[❯›>]/u.test(lines[row.index]));
    const pickerTitle = lines.slice(0, numberRows[0].index).findLastIndex(line => titleHint.test(line) && !hint.test(line));
    if ((cursor || footer) && (approval || (cursor && pickerTitle >= 0) || (cursor && updateMenu))) {
      return { kind: 'numbered', title: askTitle, ...contextAbove(lines, askTitleIndex), items: numberRows.map(row => ({ label: row.match[2].replace(/\s*[│┃║]\s*$/u, '').trim(), sublabel: '', key: row.match[1] })),
        cursorIndex: numberRows.findIndex(row => /^\s*[❯›>]/u.test(lines[row.index])) };
    }
  }
  if (hintIndex < 0) return empty();
  const cursors = lines.slice(0, hintIndex).flatMap((line, index) => {
    const match = /^(\s*)[❯›>→] (\S.*)$/u.exec(line);
    return match ? [{ index, column: match[1].length + (line.trimStart().startsWith('→') ? 4 : 2), label: match[2].replace(/^✓\s*/, '').trim() }] : [];
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
  const resume = /resume\s+session|恢复会话/i.test(title) && !/Resume a previous session/i.test(title) && cli !== 'pi';
  const items = []; let cursorIndex = -1, reliable = !namedTitle || cursors.filter(row => row.index > titleIndex).length === 1;
  for (let i = start; i < end; i++) {
    const line = lines[i], value = line.trim();
    if (!value) continue;
    if (chrome(value)) continue;
    if (/^\(\d+\/\d+\)$|^Model Name:|^Model catalogs refreshed\./i.test(value)) break;
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
export function menuPageSize(menu, warnings = {}, cardBudget = 20000) {
  const budget = Math.max(1000, Math.min(20000, cardBudget) - Buffer.byteLength(JSON.stringify(menu.context ?? '').replace(/[&<>\\`*_\[\]~!]/g, 'xxxxxx')));
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
