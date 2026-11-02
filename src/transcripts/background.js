import { open, realpath, lstat } from 'node:fs/promises';
import { posix, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const textOf = r => {
  const c = r.message?.content ?? r.content ?? '';
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text ?? b.content ?? '').join('\n') : '';
};
const short = s => String(s ?? '').replace(/\s+/g, ' ').slice(0, 180);
export const emptyBackground = () => ({ running: [], finished: [], pending: {} });
export function trackBackground(state, record) {
  if (record.isSidechain) return;
  const blocks = record.message?.content;
  if (record.type === 'assistant' && Array.isArray(blocks)) for (const b of blocks) {
    if (b.type === 'tool_use' && b.input?.run_in_background) {
      state.pending[b.id] = { description: short(b.input.description ?? b.input.command ?? b.name), tool: short(b.name), startedAt: record.timestamp ?? null };
      if (Object.keys(state.pending).length > 500) delete state.pending[Object.keys(state.pending)[0]];
    }
  }
  const text = textOf(record);
  const results = Array.isArray(blocks) ? blocks.filter(b => b.type === 'tool_result') : [];
  for (const b of results) {
    const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
    const match = /Command running in background with ID:\s*([a-zA-Z0-9_-]+)[\s\S]*?Output is being written to:\s*(\S+)/.exec(body);
    const id = record.toolUseResult?.backgroundTaskId ?? match?.[1];
    const pending = state.pending[b.tool_use_id];
    if (id && pending && !state.running.some(t => t.id === id) && !state.finished.some(t => t.id === id)) {
      state.running.push({ id, ...pending, outputFile: match?.[2] ?? null });
      delete state.pending[b.tool_use_id];
    }
  }
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const field = name => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(match[1])?.[1];
    const id = field('task-id'), status = field('status');
    if (!id || !['completed', 'failed', 'killed'].includes(status) || state.finished.some(t => t.id === id)) continue;
    const index = state.running.findIndex(t => t.id === id);
    const task = index < 0 ? { id, description: short(field('summary')), startedAt: null } : state.running.splice(index, 1)[0];
    const exit = /exit code (-?\d+)/.exec(field('summary') ?? '');
    state.finished.push({ ...task, outputFile: field('output-file') ?? task.outputFile, status, exitCode: exit ? Number(exit[1]) : null, finishedAt: record.timestamp ?? null });
    state.finished = state.finished.slice(-5);
  }
}
export function screenActivity(screen) {
  const lines = stripVTControlCharacters(String(screen)).split(/\r?\n/).map(s => s.trim());
  return { spinner: lines.filter(s => /^[✻✽✶✳✢·*]\s+\S/.test(s) && /(?:…|\.\.\.|\bfor \d+\s*s|tokens|thinking)/i.test(s)).at(-1)?.slice(0, 240) ?? '',
    footerCount: lines.reduce((count, s) => {
      const m = /\b(\d+)\s+(?:shells?|tasks?)(?:\s+still running)?\b/i.exec(s);
      return m && /auto mode|to manage|still running|done\b/i.test(s) ? Number(m[1]) : count;
    }, null) };
}
export function backgroundView(background, screen, now) {
  const { footerCount } = screenActivity(screen);
  return { running: background.running.map(t => ({ ...t,
    status: footerCount === 0 && now - Date.parse(t.startedAt) > 60000 ? 'unknown' : 'running',
    minutes: Math.max(0, Math.floor((now - (Number.isFinite(Date.parse(t.startedAt)) ? Date.parse(t.startedAt) : now)) / 60000)),
  })), finished: background.finished };
}
// Only transcript-proven paths in Claude's private temp root. Resolve both the
// root and target; refuse all symlink/junction escapes before opening output.
export async function readBackgroundOutput(task, { root } = {}) {
  const path = task.outputFile;
  if (typeof path !== 'string' || !/^\/tmp\/claude-\d+\//.test(path) || path.includes('\\') || path.split('/').includes('..') || posix.normalize(path) !== path) throw new Error('unsafe_background_path');
  const allowed = root ?? /^\/tmp\/claude-\d+/.exec(path)[0];
  if (!path.startsWith(allowed + '/')) throw new Error('unsafe_background_path');
  const base = await realpath(allowed), target = await realpath(path);
  if (!target.startsWith(base + sep) || (await lstat(allowed)).isSymbolicLink()) throw new Error('unsafe_background_path');
  const file = await open(target, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('unsafe_background_path');
    const buffer = Buffer.alloc(Math.min(16384, stat.size));
    await file.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    return stripVTControlCharacters(buffer.toString('utf8')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').split('\n').slice(-30).join('\n').slice(-2500);
  } finally { await file.close(); }
}
