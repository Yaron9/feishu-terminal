import { localFiles } from './files.js';
import { readJsonl } from './jsonl.js';
import { locateSession } from './locate.js';

export function piItems(record, offset = 0) {
  if (record.type !== 'message' || !['user', 'assistant'].includes(record.message?.role)) return [];
  const message = record.message, base = { ts: record.timestamp ?? null, id: String(record.id ?? offset) };
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : [];
  const items = blocks.flatMap((block, index) => {
    if (block.type === 'text' && String(block.text ?? '').trim()) return [{ ...base, id: `${base.id}:${index}`, role: message.role, text: block.text.trim() }];
    if (message.role !== 'assistant' || block.type !== 'toolCall') return [];
    const args = block.arguments ?? {};
    const description = args.description ?? args.command ?? args.cmd ?? args.path ?? JSON.stringify(args);
    const name = String(block.name ?? 'Tool').replace(/\s+/g, ' ').slice(0, 40);
    return [{ ...base, id: String(block.id ?? `${base.id}:${index}`), role: 'tool', text: `🔧 ${name}: ${Array.from(String(description).replace(/\s+/g, ' ')).slice(0, 60).join('')}` }];
  });
  if (message.role === 'assistant' && message.stopReason === 'error' && message.errorMessage) items.push({ ...base, id: `${base.id}:error`, role: 'assistant', text: String(message.errorMessage) });
  if (message.role === 'assistant' && ['stop', 'error', 'aborted'].includes(message.stopReason)) items.push({ role: 'turn_end' });
  return items;
}

// pi names each session directory from the cwd: the leading slash is dropped
// and every remaining `/` becomes `-`, wrapped in `--…--`. Other characters
// (spaces, `_`, Unicode) are kept, so `/Users/example/sample-project` ->
// `--Users-example-sample-project--`. This is the key that lets locate narrow the scan
// to the current session directory instead of walking every historical one.
export const piSessionDir = cwd => {
  if (typeof cwd !== 'string' || !cwd) return null;
  const name = cwd.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\//g, '-');
  return name ? `--${name}--` : null;
};
const escapeRegExp = source => String(source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class PiTranscript {
  constructor({ home, files } = {}) {
    this.files = files ?? localFiles({ home });
    this.transcriptTurns = true; this.sessions = new Map();
  }
  async locate(pane, binding = {}, bindings = [], now) {
    const home = await this.files.home;
    return locateSession(this.files, pane, binding, bindings, this.sessions, {
      key: 'pi', root: this.files.join(home, '.pi', 'agent', 'sessions'), depth: 1,
      directory: null, file: '\\.jsonl$',
      directoryForCwd: cwd => { const dir = piSessionDir(cwd); return dir ? `^${escapeRegExp(dir)}$` : null; },
      matchesId: (name, id) => name.endsWith(`_${id}.jsonl`),
      meta: r => r.type === 'session' ? { id: r.id, cwd: r.cwd, timestamp: r.timestamp } : null,
      items: piItems,
    }, now);
  }
  // Appended records are the current branch; tail reading needs no active-path walk.
  async read(path, cursor) { return readJsonl(path, cursor?.atEnd ? null : cursor, piItems, { end: Boolean(cursor?.atEnd), files: this.files }); }
}
