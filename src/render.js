import { lookupCli } from './cli-table.js';
import { stripVTControlCharacters } from './ansi.js';
import { detectMenu, menuControls } from './menus.js';
import { CLIPPED_TIP, RECOVERY_TIP } from './card-tips.js';

export function clean(text) {
  return stripVTControlCharacters(String(text ?? '')).replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function stripChrome(text) {
  const lines = clean(text).split('\n');
  const decorated = lines.map(line => {
    const chars = Array.from(line.replace(/\s/g, ''));
    return chars.length > 0 && chars.filter(char => /[\u2500-\u259f\u2800-\u28ff]/u.test(char)).length / chars.length > 0.5;
  });
  const banner = lines.map((line, i) => /[\u2580-\u259f]/u.test(line) &&
    (decorated[i] || /(?:Claude Code\s+v?\d|(?:Opus|Sonnet|Haiku)\s+[\d.])/i.test(line)));
  return lines.filter((line, i) => {
    const value = line.trim();
    const nearBanner = banner.slice(Math.max(0, i - 3), i + 4).some(Boolean);
    const bannerInfo = /(?:Claude Code\s+v?\d|(?:Opus|Sonnet|Haiku)\s+[\d.]|Claude (?:Max|Pro)|API Usage Billing)/i.test(value);
    return !(decorated[i] || (nearBanner && (bannerInfo || /^[\u2580-\u259f]+(?:\s|$)/u.test(value))) || /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝+\-]{3,}$/.test(value) ||
      /^[❯›](?:\s|$)/.test(value) || /^[>\$]\s*$/.test(value) ||
      /^[✻✽✶✳✢·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/.test(value) ||
      /^(?:Worked for|Thinking|Brewing|Cogitating|Churning|Wandering|Esc to interrupt|ctrl\+c to interrupt)\b/i.test(value));
  }).map(line => line.replace(/^\s*[│┃║]\s?/, '').replace(/\s*[│┃║]\s*$/, '')).join('\n').trimEnd();
}

const tail = (text, count) => Array.from(text).slice(-count).join('');
const markup = text => clean(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const codeBlock = text => '```text\n' + markup(text).replace(/`/g, '`\u200b') + '\n```';
const markdown = content => ({ tag: 'markdown', content });
const accent = (text, color = 'grey') => `<font color='${color}'>${markup(text)}</font>`;
const literal = text => markup(text).replace(/[\\`*_\[\]~!]/g, '\\$&');
const short = (text, count = 180) => Array.from(clean(text ?? '')).slice(0, count).join('');
const prose = text => text.split('\n').map(line => /^(?:错误|出错|失败|Error\b|Failed\b)/i.test(line.trim()) ? accent(line, 'red') : markup(line)).join('\n');
const CLIPPED = '内容较长，仅显示末尾约 1500 字';
const tipLine = text => ({ ...markdown(accent(text)), text_size: 'notation' });
const roleCard = (title, template, elements) => ({ schema: '2.0', config: { update_multi: true },
  header: { template, title: { tag: 'plain_text', content: title } }, body: { elements } });

export function withSessionHeader(card, { title, sessionId }) {
  const line = markdown("<font color='grey'>" + literal(`会话：${String(title).replace(/\s+/g, ' ')} · ${sessionId ? sessionId.slice(0, 8) : '编号未知'}`) + '</font>');
  return card.body ? { ...card, body: { ...card.body, elements: [line, ...card.body.elements] } } :
    { ...card, elements: [line, ...card.elements] };
}

export function assistantCard(text, tools = [], agent = 'Claude') {
  text = stripChrome(text);
  const clipped = Array.from(text).length > 1500;
  const elements = [markdown((clipped ? accent(CLIPPED) + '\n\n' : '') + prose(tail(text, 1500) || '（工具调用）'))];
  if (tools.length) elements.push({ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: `🔧 工具调用 (${tools.length})` } },
    elements: [markdown(accent(tail(tools.map(t => String(t).replace(/\s+/g, ' ').slice(0, 140)).join('\n'), 1500)))] });
  if (clipped) elements.push(tipLine(CLIPPED_TIP));
  return roleCard(`🤖 ${String(agent).slice(0, 40)} · 已完成`, 'green', elements);
}

export function userCard(text) {
  const clipped = Array.from(text).length > 1500;
  return roleCard('🧑 电脑端输入', 'grey', [markdown((clipped ? accent(CLIPPED) + '\n\n' : '') + markup(tail(text, 1500))),
    markdown(accent('这是你在电脑端发送的内容；回复显示在下方，可在本话题继续。'))]);
}

export function outputCard(text, { full = false } = {}) {
  const content = full ? clean(text) : stripChrome(text);
  const lines = content.split('\n'), limit = full ? Infinity : 60;
  const body = tail(lines.slice(-limit).join('\n'), full ? 4000 : 3000);
  const clipped = lines.length > limit || body.length < content.length;
  return roleCard(full ? '💻 当前屏幕' : '💻 命令输出', 'grey',
    [markdown(codeBlock(body)), ...(clipped ? [tipLine(CLIPPED_TIP)] : [])]);
}

export function screenText(text, rows = 40, width = 120) {
  const all = clean(text).split('\n');
  const visible = all.slice(-rows).map(line => {
    const chars = Array.from(line);
    return chars.length > width ? chars.slice(0, width).join('') + ' … [本行过长，已截短]' : line;
  });
  if (all.length > rows) visible.unshift('[前面的行已省略]');
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

export function screenControls(text = '') {
  const lines = clean(text).split('\n');
  const options = lines.flatMap(line => {
    const match = /^\s*(?:[❯›>│┃║]\s*)?([1-9])[.)、．）]\s*(\S.*)$/u.exec(line);
    return match ? [[`${match[1]} ${short(match[2], 60)}`, match[1]]] : [];
  }).filter((item, i, all) => all.findIndex(other => other[1] === item[1]) === i);
  const enter = !options.length && /(?:press\s+(?:the\s+)?enter|enter\s+to\s+(?:confirm|continue|proceed|submit)|按\s*(?:下\s*)?(?:Enter|回车)|↵)/i.test(text);
  return [...(enter ? [['Enter 继续', 'enter']] : []), ['Esc 取消', 'esc'], ...options,
    ['y 同意', 'y'], ['n 拒绝', 'n'], ['Ctrl-C 中断', 'ctrl+c'], ['刷新', 'refresh']];
}

function blockedPrompt(text) {
  const lines = stripChrome(text).split('\n').map(line => line.trim()).filter(Boolean);
  const candidates = lines.filter(line => !/^(?:[❯›>]\s*)?\d[.)、．）]/.test(line));
  const prompt = candidates.findLast(line => /[?？]/.test(line)) ?? candidates.findLast(line => /(?:permission|allow|confirm|proceed|是否|确认|允许)/i.test(line));
  return markdown('**等待你确认：** ' + literal(short(prompt || lines.at(-1) || '请查看终端中的确认提示', 300)) + '\n' + accent('点按钮等于在终端里按对应的键'));
}

function menuPrompt(menu, menuUI, agent = 'Claude') {
  const warning = menuUI?.confirm ? '\n⚠️ 此会话已在其他终端运行，同时恢复可能损坏会话记录。确定仍要恢复？' : '';
  return markdown((menu.context ? codeBlock(menu.context) + '\n' : '') + `**${literal(short(agent, 40))} 正在等你从菜单里选择**` + (menu.title ? ' · ' + literal(short(menu.title, 300)) : '') +
    '\n' + accent('点选项按钮即可选择，无需输入文字。') + warning);
}

export function turnCard({ turn, topicId, nonce, note, screen = '', menuUI, suppressMenu = false, tip = '' }) {
  const menu = detectMenu(suppressMenu ? '' : screen, { status: turn.status, cli: turn.adapter });
  if (menu.kind) return menuCard({ menu, topicId, nonce, menuUI });
  const preview = stripChrome(turn.text);
  const elements = [markdown((turn.truncated || Array.from(preview).length > 1500 ? accent(CLIPPED) + '\n\n' : '') + prose(tail(preview, 1500) || (turn.settled ? '（本轮结束）' : '（等待回复）')))];
  if (turn.toolCount) elements.push({ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: `🔧 工具调用 (${turn.toolCount})` } },
    elements: [markdown((turn.toolsTruncated ? accent('工具较多，仅显示末尾') + '\n\n' : '') + accent(tail(turn.tools, 1500)))] });
  if (note) elements.unshift(markdown(note));
  if (turn.duplicateWarning) elements.unshift(markdown(accent(turn.duplicateWarning, 'orange')));

  if (!turn.settled && turn.liveActivity) elements.unshift(markdown(accent(turn.liveActivity)));
  const running = turn.background?.running ?? [];
  const finished = (turn.background?.finished ?? []).slice(-5);
  if (running.length || finished.length) {
    elements.push(markdown(`**⏳ 后台运行中（${running.length}）**` + '\n' + running.map(task =>
      prose(`• ${short(task.description)} · ${task.status === 'unknown' ? '状态未知' : `已运行 ${task.minutes} 分钟`}`) +
      (task.tail ? '\n' + accent('   └ ' + task.tail) : '')).join('\n') +
      (finished.length ? '\n' + finished.map(task => accent(`${task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏹'} ${short(task.description)} ${task.status === 'completed' ? '完成' : task.status === 'failed' ? `失败（exit ${task.exitCode ?? '?'}）` : ['killed', 'stopped'].includes(task.status) ? '已停止' : short(task.status)}`)).join('\n') : '')));

  }
  const blocked = !turn.settled && turn.status === 'blocked';
  if (blocked) elements.push(blockedPrompt(screen || turn.text));
  const buttons = screenControls(screen || turn.text);
  if (blocked) for (let i = 0; i < buttons.length; i += 3) elements.push({
    tag: 'column_set', flex_mode: 'none', columns: buttons.slice(i, i + 3).map(([label, key]) => ({
      tag: 'column', width: 'weighted', weight: 1, elements: [{
        tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default',
        behaviors: [{ type: 'callback', value: { topic_id: topicId, nonce, key } }],
      }],
    })),
  });
  const failed = ['error', 'failed', 'frozen'].includes(turn.status);
  const activity = failed ? '出错' : turn.settled ? (running.length ? `本轮完成 · 后台 ${running.length} 个任务运行中` : '已完成') : blocked ? '等待你确认' : '工作中';
  const contextual = failed ? RECOVERY_TIP : blocked ? '' :
    turn.truncated || turn.toolsTruncated || Array.from(preview).length > 1500 ? CLIPPED_TIP : tip;
  if (contextual) elements.push(tipLine(contextual));
  return roleCard(`🤖 ${String(turn.agent).slice(0, 40)} · ${activity}`,
    failed ? 'red' : blocked ? 'orange' : turn.settled ? (running.length ? 'wathet' : 'green') : 'blue', elements);
}

export function pickerCard(card, result) {
  result ??= card.result;
  const elements = [];
  const text = content => ({ tag: 'div', text: { tag: 'plain_text', content } });
  const row = entry => ({ tag: 'div', text: { tag: 'lark_md', content: `**${literal(short(entry.title || entry.label))}**` +
    (entry.summary ? '\n' + literal(short(entry.summary, 500)) : '') +
    (entry.topicDescription ? literal(entry.summary?.includes('已暂停同步') ? ` · 话题${entry.topicDescription}` : entry.summary?.endsWith('已绑定话题') ? entry.topicDescription : ` · 已绑定话题${entry.topicDescription}`) : '') } });
  const id = entry => ({ tag: 'note', elements: [{ tag: 'lark_md', content: accent(short(entry.paneId)) }] });
  const buttons = (items, index) => ({ tag: 'action', actions: items.map(([label, action]) => ({
    tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default',
    value: { topic_id: card.topicId, nonce: card.nonce, key: `picker:${action}:${index}` },
  })) });
  if (result && typeof result === 'object') card.entries.forEach((entry, index) => {
    elements.push(index === result.index ? text(result.text) : row(entry));
    if (card.kind === 'recovered' && index === result.index) elements.push(buttons([['移到新话题', 'move']], index));
    if (index !== result.index && entry.paneId) elements.push(id(entry));
  });
  else if (result) elements.push(text(result));
  else card.entries.forEach((entry, index) => {
    elements.push(card.kind === 'confirm' ? text(`确定关闭「${short(entry.title || entry.label)}」？里面的会话会结束，正在运行的程序和未保存的内容将丢失，不可恢复。`) : row(entry));
    elements.push(buttons(card.kind === 'list' ? [['打开', 'open'], ['关闭', 'close'], ...(entry.canMove ? [['移到新话题', 'move']] : [])] :
      card.kind === 'confirm' ? [['确定关闭', 'kill'], ['取消', 'cancel']] :
        [['仅解绑', 'unbind'], ['关闭终端', 'kill'], ['取消', 'cancel']], index));
    if (entry.paneId) elements.push(id(entry));
  });
  if (!elements.length) elements.push(text('暂无终端'));
  if (!result && card.kind === 'list') elements.unshift(text('[打开] 把终端接到一个话题里同步 · [关闭] 解绑或关闭终端 · [移到新话题] 原话题找不到时用'));
  if (!result && card.kind === 'close') elements.unshift(text('仅解绑：话题停止同步，终端继续在 VPS 上运行\n关闭终端：结束终端里的程序（如 Claude 会话），不可恢复'));
  return { config: { wide_screen_mode: true, update_multi: true },
    header: { template: result ? 'grey' : card.kind === 'confirm' ? 'red' : card.kind === 'close' ? 'orange' : 'blue', title: { tag: 'plain_text', content: ['list', 'recovered'].includes(card.kind) ? `终端列表（共 ${card.entries.length} 个）` : '关闭终端' } }, elements };
}

export function screenCard({ paneId, label = '终端', agent, topicId, nonce, status = 'unknown', text, output, note, menuUI, suppressMenu = false }) {
  const menu = detectMenu(suppressMenu ? '' : text, { status, cli: agent });
  if (menu.kind) return menuCard({ menu, topicId, nonce, menuUI });
  // Escaped HTML avoids terminal output creating mentions/card markup. The
  // zero-width separator prevents terminal backticks ending the code fence.
  const lines = stripChrome(text).split('\n').filter(line => line.trim());
  const preview = lines.slice(-10).join('\n');
  const clipped = !output && (lines.length > 10 || lines.some(line => Array.from(line).length > 120));
  const display = output || screenText(preview, 10);
  const elements = [markdown(lookupCli({ agent }) ? prose(stripChrome(display)) : codeBlock(display))];
  if (note) elements.unshift({ tag: 'div', text: { tag: 'plain_text', content: note } });
  if (status === 'blocked') {
    elements.push(blockedPrompt(text));
    const buttons = screenControls(text);
    for (let i = 0; i < buttons.length; i += 3) elements.push({
      tag: 'action', actions: buttons.slice(i, i + 3).map(([label, key]) => ({
        tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default',
        value: { topic_id: topicId, nonce, key },
      })),
    });
  }
  const shell = agent === null || (agent === undefined && status === 'unknown');
  const activity = shell ? (status === 'working' ? '运行中' : '空闲') :
    ({ working: '工作中', idle: '空闲', done: '已完成', blocked: '等待你确认', error: '出错', failed: '出错' }[status] ?? '状态待更新');
  if (['error', 'failed', 'frozen'].includes(status)) elements.push(tipLine(RECOVERY_TIP));
  else if (status !== 'blocked' && clipped) elements.push(tipLine(CLIPPED_TIP));
  if (paneId) elements.push({ tag: 'note', elements: [{ tag: 'lark_md', content: accent(short(paneId)) }] });
  return { config: { wide_screen_mode: true, update_multi: true }, header: { template: shell ? 'grey' : ['error', 'failed'].includes(status) ? 'red' : status === 'blocked' ? 'orange' : status === 'done' ? 'green' : 'blue',
    title: { tag: 'plain_text', content: `${shell ? '命令行' : '●'} · ${activity} · ${short(label)}` } }, elements };
}

// JSON 2.0: one full-width interactive container per menu item. No text limits:
// Markdown wraps naturally; callbacks carry only the index and safety identity.
export function menuCard({ menu, topicId, nonce, menuUI = {}, result, agent = 'Claude' }) {
  if (result !== undefined) return roleCard('菜单', result ? 'green' : 'grey',
    [markdown(result ? "<font color='green'>已选择：" + literal(result) + '</font>' : accent('菜单已关闭'))]);
  const elements = menuElements({ menu, topicId, nonce, menuUI, agent });
  const card = roleCard(`${short(agent, 40)} · 等待菜单选择`, 'orange', elements);
  if (Buffer.byteLength(JSON.stringify(card)) >= 28000) throw new Error('Menu item exceeds card size limit');
  return card;
}

export function menuElements({ menu, topicId, nonce, menuUI = {}, agent = 'Claude' }) {
  const controls = menu.kind === 'list' ? menuControls(menu, menuUI) :
    [...menu.items.map((item, i) => [item.label, String(i + 1)]), ['Esc 取消', 'esc'], ['刷新', 'refresh']];
  const value = key => ({ topic_id: topicId, nonce, key });
  const elements = [menuPrompt(menu, menuUI, agent)];
  for (const [label, key] of controls) {
    const match = /^menu:(?:select|confirm):(\d+)$/.exec(key);
    const index = match ? Number(match[1]) : menu.kind === 'numbered' && /^\d$/.test(key) ? Number(key) - 1 : -1;
    if (index < 0) continue;
    const item = menu.items[index] ?? { label, sublabel: '' };
    const warning = menuUI.warnings?.[index];
    const text = (index === menu.cursorIndex ? '▶ ' : '') + literal(item.label) +
      (item.sublabel ? '\n' + "<font color='grey'>" + literal(item.sublabel) + '</font>' : '') +
      (warning?.length ? '\n' + literal('⚠️ 已在 ' + warning.map(w => w.label).join('、') + ' 运行') : '') +
      (key.startsWith('menu:confirm:') ? '\n**确定恢复**' : '');
    elements.push({ tag: 'interactive_container', width: 'fill', height: 'auto',
      has_border: true, border_color: 'grey', corner_radius: '8px',
      behaviors: [{ type: 'callback', value: value(key) }], elements: [markdown(text)] });
  }
  for (const [label, key] of controls) {
    if (/^menu:(?:select|confirm):/.test(key) || (menu.kind === 'numbered' && /^\d$/.test(key))) continue;
    elements.push({ tag: 'button', width: 'fill', text: { tag: 'plain_text', content: short(label, 60) },
      type: 'default', behaviors: [{ type: 'callback', value: value(key) }] });
  }
  return elements;
}
