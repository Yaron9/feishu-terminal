import { readFile, stat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { probeClaude, lookupCli } from '../cli-table.js';
import { paneProcess } from './proc.js';
import { readJsonl } from './jsonl.js';
import { emptyBackground, trackBackground, stopBackground } from './background.js';

export const projectDirectory = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const realText = text => String(text).replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '').trim();
const command = text => /^\s*(?:<\/?(?:command-name|command-message|command-args|local-command|local-command-stdout|local-command-caveat|task-notification)\b|\[Request interrupted by user)/i.test(text);

export function claudeItems(record, offset = 0) {
  if (record.type === 'system' && record.subtype === 'turn_duration') return [{ role: 'turn_end' }];
  if (record.isCompactSummary) return [];
  if (record.isMeta || record.isSidechain || record.subtype || !['user', 'assistant'].includes(record.type)) return [];
  const content = record.message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const base = { ts: record.timestamp ?? null, id: String(record.uuid ?? offset) };
  if (record.type === 'user') {
    if (blocks.some(b => b.type === 'tool_result') || blocks.some(b => b.type === 'text' && command(realText(b.text ?? '')))) return [];
    const text = blocks.filter(b => b.type === 'text').map(b => realText(b.text ?? '')).filter(t => t && !command(t)).join('\n');
    return text ? [{ ...base, role: 'user', text }] : [];
  }
  return blocks.flatMap((block, index) => {
    if (block.type === 'text') {
      const text = realText(block.text ?? '');
      return text ? [{ ...base, id: `${base.id}:${index}`, role: 'assistant', text }] : [];
    }
    if (block.type !== 'tool_use') return [];
    const description = block.input?.description ?? block.input?.command ?? block.input?.file_path ?? '';
    const name = String(block.name ?? 'Tool').replace(/\s+/g, ' ').slice(0, 40);
    return [{ ...base, id: String(block.id ?? `${base.id}:${index}`), role: 'tool',
      text: `🔧 ${name}: ${Array.from(String(description).replace(/\s+/g, ' ')).slice(0, 60).join('')}` }];
  });
}

export class ClaudeTranscript {
  constructor({ home = homedir(), procRoot = '/proc', cacheLimit = 512 } = {}) {
    Object.assign(this, { home, procRoot, cacheLimit }); this.transcriptTurns = true; this.backgrounds = new Map(); this.sessions = new Map();
  }
  remember(cache, path, value) {
    cache.delete(path); cache.set(path, value);
    while (cache.size > this.cacheLimit) cache.delete(cache.keys().next().value);
    return value;
  }
  async locate(pane) {
    // A remote PID belongs to a different /proc namespace.
    if (/^hc:[^/]+\//.test(pane.pane_id)) return null;
    // hc exposes the actual foreground PID. Validate it before opening the
    // exact session JSON, with the environment-based legacy lookup as fallback.
    let pid = pane.foreground?.pid ?? pane.foreground_pid;
    if (pid) {
      try { if ((await readFile(join(this.procRoot, String(pid), 'comm'), 'utf8')).trim() !== 'claude') pid = null; }
      catch { pid = null; }
    }
    if (!pid) pid = await paneProcess(pane.pane_id, 'claude', this.procRoot);
    if (!pid && lookupCli(pane)?.cli === 'claude') {
      const cwd = pane.foreground?.cwd ?? pane.foreground_cwd ?? pane.cwd;
      const found = cwd && await probeClaude({ home: this.home, cwd, startedAfterMs: pane.created_ms ?? 0 });
      if (found?.sessionId) pid = Number(basename(found.source, '.json'));
    }
    if (!pid) return null;
    try {
      // Exact .json filename only. Never enumerate or open the adjacent *.key files.
      const { sessionId, cwd, pid: sessionPid } = JSON.parse(await readFile(join(this.home, '.claude', 'sessions', `${pid}.json`), 'utf8'));
      if (Number(sessionPid) !== pid || typeof cwd !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
      const path = join(this.home, '.claude', 'projects', projectDirectory(cwd), `${sessionId}.jsonl`);
      // Validate the actual escaped directory/file rather than guessing another project.
      if (!(await stat(path)).isFile()) return null;
      const previous = this.sessions.get(path);
      const restartedAt = new Date((await stat(join(this.home, '.claude', 'sessions', `${pid}.json`))).mtimeMs).toISOString();
      this.remember(this.sessions, path, { sessionId, pid, restartedAt, restarted: previous?.restarted || Boolean(previous && previous.pid !== pid) });
      return path;
    } catch { return null; }
  }
  async duplicates(path) {
    const session = this.sessions.get(path);
    if (!session) return [];
    const directory = join(this.home, '.claude', 'sessions');
    let names;
    try { names = await readdir(directory); } catch { return []; }
    const duplicates = [];
    for (const name of names.filter(name => /^\d+\.json$/.test(name))) {
      try {
        // Project only these two fields; never retain or log session payloads.
        const { pid, sessionId } = JSON.parse(await readFile(join(directory, name), 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0 || name !== `${pid}.json` || pid === session.pid || sessionId !== session.sessionId) continue;
        if ((await readFile(join(this.procRoot, String(pid), 'comm'), 'utf8')).trim() === 'claude') duplicates.push(pid);
      } catch { /* Exited, inaccessible or invalid session. */ }
    }
    return duplicates.sort((a, b) => a - b);
  }
  // atEnd initializes a binding without reading historical records. Otherwise
  // the cursor is the opaque object returned by the preceding read.
  async read(path, cursor) {
    let entry = this.backgrounds.get(path);
    entry = this.remember(this.backgrounds, path, entry ?? { background: emptyBackground(), scan: null });
    // Drain bounded windows on startup and then only appended bytes. The
    // tracker cursor is independent of the delivery cursor (pending retries).
    for (;;) {
      const next = await readJsonl(path, entry.scan, record => { trackBackground(entry.background, record); return []; },
        { onReset: () => { entry.background = emptyBackground(); } });
      const done = next.cursor.offset === entry.scan?.offset;
      entry.scan = next.cursor;
      if (done) break;
    }
    const result = await readJsonl(path, cursor?.atEnd ? null : cursor, claudeItems, { end: Boolean(cursor?.atEnd) });
    const session = this.sessions.get(path);
    const restartedAt = session && (session.restarted || (cursor?.pid != null && cursor.pid !== session.pid))
      ? session.restartedAt : cursor?.restartedAt;
    if (restartedAt) { stopBackground(entry.background, restartedAt); result.cursor.restartedAt = restartedAt; }
    if (session) result.cursor.pid = session.pid;
    result.cursor.duplicates = await this.duplicates(path);
    result.cursor.background = structuredClone(entry.background);
    return result;
  }
}
