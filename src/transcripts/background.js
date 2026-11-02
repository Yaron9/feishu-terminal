import { open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix, sep } from 'node:path';
import { stripVTControlCharacters } from '../ansi.js';

const textOf = r => {
  const c = r.message?.content ?? r.content ?? '';
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text ?? b.content ?? '').join('\n') : '';
};
const short = s => String(s ?? '').replace(/\s+/g, ' ').slice(0, 180);
export const emptyBackground = () => ({ running: [], finished: [], pending: {} });
export function stopBackground(state, restartedAt = null) {
  const cutoff = Date.parse(restartedAt);
  const stopped = state.running.filter(t => !Number.isFinite(cutoff) || !Number.isFinite(Date.parse(t.startedAt)) || Date.parse(t.startedAt) < cutoff);
  state.running = state.running.filter(t => !stopped.includes(t));
  state.finished = [...state.finished, ...stopped.map(t => ({ ...t, status: 'stopped', finishedAt: restartedAt, exitCode: null }))].slice(-5);
  for (const [id, t] of Object.entries(state.pending)) {
    if (!Number.isFinite(cutoff) || !Number.isFinite(Date.parse(t.startedAt)) || Date.parse(t.startedAt) < cutoff) delete state.pending[id];
  }
}
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
      state.running = state.running.slice(-500);
      delete state.pending[b.tool_use_id];
    }
  }
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const field = name => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(match[1])?.[1];
    const id = field('task-id'), status = field('status');
    if (/previous session ended/i.test(field('summary') ?? '')) stopBackground(state, record.timestamp);
    if (!id || !status) continue;
    const index = state.running.findIndex(t => t.id === id);
    const previous = state.finished.find(t => t.id === id);
    const task = index < 0 ? previous ?? { id, description: short(field('summary')), startedAt: null } : state.running.splice(index, 1)[0];
    state.finished = state.finished.filter(t => t.id !== id);
    const exit = /exit code (-?\d+)/.exec(field('summary') ?? '');
    state.finished.push({ ...task, outputFile: field('output-file') ?? task.outputFile, status, exitCode: exit ? Number(exit[1]) : null, finishedAt: record.timestamp ?? null });
    state.finished = state.finished.slice(-5);
  }
}
export function screenActivity(screen) {
  const lines = stripVTControlCharacters(String(screen)).split(/\r?\n/).map(s => s.trim());
  return { spinner: lines.filter(s => /^[✻✽✶✳✢·*]\s+\S/.test(s) && /(?:…|\.\.\.|\bfor \d+\s*s|tokens|thinking)/i.test(s)).at(-1)?.slice(0, 240) ?? '',
    footerCount: lines.reduce((count, s) => {
      const m = /\b(\d+)\s+(?:shells?|tasks?|agents?)(?:\s+still running)?\b/i.exec(s);
      return m && /auto mode|to manage|still running|done\b/i.test(s) ? Number(m[1]) : count;
    }, lines.some(s => /^(?:⏵⏵\s+auto mode\b|.*(?:bypass permissions|accept edits)\s+(?:on|·)|\?\s+for shortcuts\b|[❯›]\s*$)/i.test(s)) ? 0 : null) };
}
export function backgroundView(background, screen, now) {
  const { footerCount } = screenActivity(screen);
  return { running: background.running.map(t => ({ ...t,
    status: footerCount === 0 && now - Date.parse(t.startedAt) > 60000 ? 'unknown' : 'running',
    minutes: Math.max(0, Math.floor((now - (Number.isFinite(Date.parse(t.startedAt)) ? Date.parse(t.startedAt) : now)) / 60000)),
  })), finished: background.finished };
}

// Only transcript-proven paths inside Claude's private temporary directory.
export async function readBackgroundOutput(task) {
  const path = task.outputFile;
  if (typeof path !== 'string' || !/^\/tmp\/claude-\d+\//.test(path) || path.includes('\\') ||
      path.split('/').includes('..') || posix.normalize(path) !== path) throw new Error('unsafe_background_path');
  const allowed = /^\/tmp\/claude-\d+/.exec(path)[0];
  const base = await realpath(allowed), target = await realpath(path);
  if (!target.startsWith(base + sep) || (await lstat(allowed)).isSymbolicLink()) throw new Error('unsafe_background_path');
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('unsafe_background_path');
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('unsafe_background_path');
    const buffer = Buffer.alloc(Math.min(4096, stat.size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    return extractBackgroundTail(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}

// Bound terminal display columns, including wide CJK/emoji and combining marks.
export function extractBackgroundTail(text) {
  const line = stripVTControlCharacters(String(text)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\ufffd]/g, '')
    .split('\n').map(s => s.trim()).filter(Boolean).at(-1) ?? '';
  let result = '', columns = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line.replace(/\t/g, ' '))) {
    const width = /^[\p{Mark}\p{Cf}]+$/u.test(segment) ? 0 : /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Unified_Ideograph}\u20e3\ufe0f\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(segment) ? 2 : 1;
    if (columns + width > 80) break;
    columns += width; result += segment;
  }
  return result;
}

// Cache the read attempt as well as the result, so missing/unsafe files cannot
// cause polling on every tick. This metadata is separate from the card signature.
export async function refreshBackgroundTails(background, cache, cardKey, now, read = readBackgroundOutput) {
  if (cache?.cardKey !== cardKey) cache = null;
  if (!cache || now - cache.at >= 10000) {
    const lines = {};
    for (const task of background.running) {
      try { lines[task.id] = { path: task.outputFile, text: await read(task) }; }
      catch { lines[task.id] = { path: task.outputFile, text: '' }; }
    }
    cache = { cardKey, at: now, lines };
  }
  for (const task of background.running) {
    const cached = cache.lines[task.id];
    task.tail = cached?.path === task.outputFile ? cached.text : '';
  }
  return cache;
}
