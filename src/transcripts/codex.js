import { localFiles } from './files.js';
import { readJsonl } from './jsonl.js';
import { locateSession } from './locate.js';

const injected = blocks => blocks.some(b => /^(?:# AGENTS\.md instructions\b|<environment_context>)/.test(String(b.text ?? '').trimStart()));
const extractText = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  return typeof value.text === 'string' ? value.text : typeof value.message === 'string' ? value.message : extractText(value.content ?? value.payload);
};
function cleanText(text) {
  const value = String(text).replace(/\r\n/g, '\n')
    .replace(/<!--\s*(?:FACTS|MEMORY):START\s*-->[\s\S]*?<!--\s*(?:FACTS|MEMORY):END\s*-->/gi, '')
    .replace(/\[(?:System hints - DO NOT mention these to user|Mac automation policy - do NOT expose this block):[\s\S]*?\]/gi, '')
    .replace(/\[Task notification\][\s\S]*?(?=\n{2,}|$)|<task-notification\b[\s\S]*?(?:<\/task-notification>|$)/gi, '')
    .replace(/\n*(?:System hints \(internal, do not mention to user\):|\[Respond in Simplified Chinese|\[Agent memory snapshot:|\[Relevant facts:)[\s\S]*/i, '').trim();
  if (/^(?:you are a meta ?me\b|you are a session reflection assistant\b|you are a metacognition pattern detector\b|you are codex, based on gpt-5\b|\[nightly-reflect\]|\[self-reflect\]|\[memory-)/i.test(value) || /(?:RECALLED LONG-TERM FACTS \(context only|MANDATORY FIRST ACTION: The user has not been calibrated yet|<!--\s*(?:FACTS|MEMORY):START\s*-->|\[上次对话摘要|\b(?:previous|prior|generated)\s+session\s+summary\b|<task-notification\b)/i.test(value)) return '';
  return value.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[REDACTED_SECRET]')
    .replace(/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]+|xox[baprs]-[a-z0-9-]+)\b/gi, '[REDACTED_SECRET]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/(\b(?:[A-Z0-9]+_)*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|TOKEN)(?:_[A-Z0-9]+)*\b\s*[:=]\s*)(["']?)[^\s,"'}]+\2/gi, '$1[REDACTED_SECRET]');
}
export function codexItems(record, offset = 0) {
  const p = record.payload ?? {};
  if (record.type === 'event_msg' && p.type === 'task_complete') return [{ role: 'turn_end' }];
  if (record.type !== 'response_item') return [];
  const base = { ts: record.timestamp ?? null, id: String(p.call_id ?? offset) };
  if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
    const blocks = Array.isArray(p.content) ? p.content : [{ text: extractText(p.content ?? p) }];
    if (p.role === 'user' && injected(blocks)) return [];
    const text = cleanText(extractText(p.content ?? p));
    return text ? [{ ...base, role: p.role, text }] : [];
  }
  if (!['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) return [];
  let args = p.arguments ?? p.input ?? p.action ?? '';
  try { if (typeof args === 'string') args = JSON.parse(args); } catch { /* freeform tool input */ }
  const description = typeof args === 'object' && args !== null ? args.description ?? args.cmd ?? args.command ?? args.path ?? JSON.stringify(args) : args;
  const name = String(p.name ?? p.tool_name ?? (p.type === 'local_shell_call' ? 'shell' : 'Tool')).replace(/\s+/g, ' ').slice(0, 40);
  return [{ ...base, role: 'tool', text: `🔧 ${name}: ${Array.from(String(description).replace(/\s+/g, ' ')).slice(0, 60).join('')}` }];
}

export class CodexTranscript {
  constructor({ home, files } = {}) {
    this.files = files ?? localFiles({ home });
    this.transcriptTurns = true; this.sessions = new Map();
  }
  async locate(pane, binding = {}, bindings = [], now) {
    const home = await this.files.home;
    return locateSession(this.files, pane, binding, bindings, this.sessions, {
      key: 'codex', root: this.files.join(home, '.codex', 'sessions'), depth: 3,
      directory: '^\\d+$', file: '^rollout-.*\\.jsonl$',
      matchesId: (name, id) => name.endsWith(`-${id}.jsonl`),
      meta: r => r.type === 'session_meta' ? { id: r.payload?.session_id ?? r.payload?.id, cwd: r.payload?.cwd, timestamp: r.timestamp ?? r.payload?.timestamp } : null,
      items: codexItems,
    }, now);
  }
  async read(path, cursor) { return readJsonl(path, cursor?.atEnd ? null : cursor, codexItems, { end: Boolean(cursor?.atEnd), files: this.files }); }
}
