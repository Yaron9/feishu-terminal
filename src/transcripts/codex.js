import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { sameCwd, resumeSessionId, CLI_TABLE } from '../cli-table.js';
import { echoIndex, inputHash } from '../input-echo.js';
import { readJsonl } from './jsonl.js';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
const injected = blocks => blocks.some(b => /^(?:# AGENTS\.md instructions\b|<environment_context>)/.test(String(b.text ?? '').trimStart()));
export function codexItems(record, offset = 0) {
  const p = record.payload ?? {};
  if (record.type === 'event_msg' && p.type === 'task_complete') return [{ role: 'turn_end' }];
  if (record.type !== 'response_item') return [];
  const base = { ts: record.timestamp ?? null, id: String(p.call_id ?? offset) };
  if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
    const blocks = Array.isArray(p.content) ? p.content : [];
    if (p.role === 'user' && injected(blocks)) return [];
    const text = blocks.filter(b => ['input_text', 'output_text', 'text'].includes(b.type)).map(b => b.text ?? '').filter(Boolean).join('\n').trim();
    return text ? [{ ...base, role: p.role, text }] : [];
  }
  if (!['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) return [];
  let args = p.arguments ?? p.input ?? p.action ?? '';
  try { if (typeof args === 'string') args = JSON.parse(args); } catch { /* freeform tool input */ }
  const description = typeof args === 'object' && args !== null ? args.description ?? args.cmd ?? args.command ?? args.path ?? JSON.stringify(args) : args;
  const name = String(p.name ?? (p.type === 'local_shell_call' ? 'shell' : 'Tool')).replace(/\s+/g, ' ').slice(0, 40);
  return [{ ...base, role: 'tool', text: `🔧 ${name}: ${Array.from(String(description).replace(/\s+/g, ' ')).slice(0, 60).join('')}` }];
}

export class CodexTranscript {
  constructor({ home = homedir() } = {}) { this.home = home; this.transcriptTurns = true; this.sessions = new Map(); }
  async locate(pane, binding = {}, bindings = []) {
    if (/^hc:[^/]+\//.test(pane.pane_id ?? '')) return null;
    const root = join(this.home, '.codex', 'sessions');
    const held = new Set(bindings.filter(b => b.topicId !== binding.topicId || b.chatId !== binding.chatId).map(b => b.transcript?.path).filter(Boolean));
    const saved = binding.transcript?.adapter === 'codex' && binding.transcript.path;
    if (saved && !held.has(saved)) { try { if ((await stat(saved)).isFile()) return saved; } catch {} }
    const row = CLI_TABLE.find(r => r.cli === 'codex');
    const paneId = pane.labels?.session ?? resumeSessionId(row, pane.foreground?.argv) ?? resumeSessionId(row, pane.argv);
    const id = validId(paneId) ? paneId : (['verified', 'probe'].includes(binding.sessionSource) && validId(binding.sessionId) && !bindings.some(b => (b.topicId !== binding.topicId || b.chatId !== binding.chatId) && b.sessionId === binding.sessionId) ? binding.sessionId : null);
    const cwd = pane.foreground?.cwd ?? pane.foreground_cwd ?? pane.cwd ?? binding.cwd;
    const command = (binding.sentInputs ?? []).findLast(i => i.hash && binding.cliCommand && i.hash === inputHash(binding.cliCommand));
    const since = binding.cliCommandSentAt ?? command?.sentAt;
    if (!id && !Number.isFinite(since)) return null;
    const matches = [];
    const walk = async (dir, depth) => {
      let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const file = join(dir, entry.name);
        if (depth && entry.isDirectory() && /^\d+$/.test(entry.name)) { await walk(file, depth - 1); continue; }
        if (depth || !entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name) || held.has(file) || (id && !entry.name.endsWith(`-${id}.jsonl`))) continue;
        try {
          if (!id && (await stat(file)).mtimeMs < since) continue;
          let meta, first;
          await readJsonl(file, null, record => {
            if (!meta && record.type === 'session_meta') meta = record;
            if (!first) first = codexItems(record).find(item => item.role === 'user');
            return [];
          });
          const sessionId = meta?.payload?.session_id ?? meta?.payload?.id;
          if (!validId(sessionId) || !basename(file).endsWith(`-${sessionId}.jsonl`) || (id && sessionId !== id) || !sameCwd(cwd, meta.payload.cwd)) continue;
          const start = Date.parse(meta.timestamp ?? meta.payload.timestamp ?? '');
          if (!id && (!Number.isFinite(start) || start < since || !first || echoIndex(first, [...(binding.sentInputs ?? [])], Date.parse(first.ts) || Date.now(), binding.identity?.terminalId) < 0)) continue;
          matches.push({ file, sessionId, fresh: !id });
        } catch { /* inaccessible or incomplete rollout */ }
      }
    };
    await walk(root, 3);
    if (matches.length !== 1) return null;
    const match = matches[0]; this.sessions.set(match.file, match); return match.file;
  }
  async read(path, cursor) { return readJsonl(path, cursor?.atEnd ? null : cursor, codexItems, { end: Boolean(cursor?.atEnd) }); }
}
