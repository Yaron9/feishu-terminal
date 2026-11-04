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
