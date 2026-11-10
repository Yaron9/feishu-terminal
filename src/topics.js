import { homedir } from 'node:os';
import { withSessionHeader } from './render.js';

// Claude's changing activity prefix must not rename a session.
export function cleanTitle(value) {
  return String(value ?? '').replace(/^[\s✳✶✻✽✢✦✧⏺●◐◑◒◓◴◵◶◷\u2800-\u28ff\uFE0F]+|[\s✳✶✻✽✢✦✧⏺●◐◑◒◓◴◵◶◷\u2800-\u28ff\uFE0F]+$/gu, '').trim();
}
export function topicTitle(pane, fallback) {
  const path = String(pane.foreground_cwd || pane.cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
  const title = cleanTitle(pane.title) || cleanTitle(pane.terminal_title_stripped);
  // A temporary activity glyph keeps the last session title. An absent title
  // falls through to terminal/process names, never a workspace/where label.
  const activityOnly = String(pane.title || pane.terminal_title_stripped || '').trim() && !title;
  return title || (activityOnly && cleanTitle(fallback)) || cleanTitle(pane.name) ||
    cleanTitle(pane.agent) || cleanTitle(pane.foreground?.name) || cleanTitle(fallback) || path.split('/').pop() || '终端';
}
export function topicCard(pane, title = topicTitle(pane), home = homedir(), sessionId = null, sessionTitle = title) {
  const path = String(pane.foreground_cwd || pane.cwd || '').replace(/\\/g, '/');
  const base = home.replace(/\\/g, '/').replace(/\/$/, '');
  const dir = path === base || path.startsWith(base + '/') ? '~' + path.slice(base.length) : path || '未提供目录';
  const agent = /^claude$/i.test(pane.agent) ? 'Claude' : /^codex$/i.test(pane.agent) ? 'Codex' : pane.agent || '命令行';
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return withSessionHeader({ schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    body: { elements: [{ tag: 'markdown', content: `<font color='grey'>${escape(`${agent} · ${dir} · ${pane.pane_id}`)}</font>` }] } }, { title: sessionTitle, sessionId });
}

export function sessionTitle(title) {
  const value = String(title ?? '').trim();
  return /\.exe$/i.test(value) || /^(?:管理员|administrator)\s*[:：]\s*(?:[a-z]:[\\/]|\\\\|\/)/i.test(value) ? '命令行' : value;
}

// One line, at most 30 characters: the picker list must stay readable in a
// terminal, so a root message never contributes a wrapped or giant title.
const listLine = value => [...cleanTitle(value).replace(/\s+/gu, ' ')].slice(0, 30).join('');

// The title `metame open` shows is what the topic is ABOUT, not what its window
// happens to say. In order: the topic's root message text (a user's first
// message or a `📨 …` delivery root; an `interactive` root has no message and is
// only the published card title), the first input sent into the topic, and only
// then the terminal title. `topicId` is the last resort so a line is never blank.
export function listTitle(binding, paneTitle) {
  const root = binding.topicRoot?.type === 'interactive' ? '' : binding.topicRoot?.text;
  const sent = (binding.sentInputs ?? []).find(item => item.prefix)?.prefix;
  // A window title that is only a shell path says '命令行', never a WindowsApps path.
  return listLine(root) || listLine(sent) || listLine(sessionTitle(paneTitle)) || listLine(binding.topicId);
}
