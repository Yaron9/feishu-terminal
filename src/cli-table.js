import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join, win32, posix } from 'node:path';

// Compare foreign path styles without resolving them against this host's cwd.
export function sameCwd(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const windows = /^[a-z]:[\\/]/i.test(a) || /^[a-z]:[\\/]/i.test(b) || a.startsWith('\\\\') || b.startsWith('\\\\');
  return windows ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase() : posix.normalize(a) === posix.normalize(b);
}
async function names(dir) { try { return await readdir(dir, { withFileTypes: true }); } catch { return []; } }
async function recent(file, since) { try { return (await stat(file)).mtimeMs >= since; } catch { return false; } }
async function firstLine(file) {
  const handle = await open(file, 'r');
  try {
    const chunks = []; let offset = 0;
    while (offset < 1024 * 1024) {
      const buffer = Buffer.alloc(4096); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      const part = buffer.subarray(0, bytesRead); const end = part.indexOf(10);
      chunks.push(end < 0 ? part : part.subarray(0, end));
      if (end >= 0) return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      offset += bytesRead;
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await handle.close(); }
}
function result(matches) {
  if (matches.length > 1) return { sessionId: null, source: null, reason: 'ambiguous' };
  return matches[0] ?? null;
}
export async function probeClaude({ cwd, startedAfterMs = 0, home }) {
  const dir = join(home, '.claude', 'sessions'), matches = [];
  for (const entry of await names(dir)) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
    const file = join(dir, entry.name);
    if (!await recent(file, startedAfterMs)) continue;
    try {
      const { sessionId, cwd: savedCwd, pid } = JSON.parse(await readFile(file, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && entry.name === `${pid}.json` && typeof sessionId === 'string' && /^[a-zA-Z0-9_-]+$/.test(sessionId) && sameCwd(cwd, savedCwd)) matches.push({ sessionId, source: file });
    } catch { /* incomplete or invalid session */ }
  }
  return result(matches);
}
async function probeFiles(root, depth, options, parse) {
  const matches = [];
  async function walk(dir, remaining) {
    for (const entry of await names(dir)) {
      const file = join(dir, entry.name);
      if (remaining > 0 && entry.isDirectory()) await walk(file, remaining - 1);
      else if (remaining === 0 && entry.isFile() && entry.name.endsWith('.jsonl') && await recent(file, options.startedAfterMs ?? 0)) {
        try { const id = parse(await firstLine(file), entry.name, options.cwd); if (id) matches.push({ sessionId: id, source: file }); } catch { /* incomplete or invalid session */ }
      }
    }
  }
  await walk(root, depth); return result(matches);
}
export function probeCodex(options) {
  return probeFiles(join(options.home, '.codex', 'sessions'), 3, options, (line, name, cwd) => {
    const id = line?.payload?.session_id;
    return /^rollout-.*\.jsonl$/.test(name) && line.type === 'session_meta' && typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && name.endsWith(`-${id}.jsonl`) && sameCwd(cwd, line.payload.cwd) ? id : null;
  });
}
export function probePi(options) {
  return probeFiles(join(options.home, '.pi', 'agent', 'sessions'), 1, options, (line, name, cwd) => {
    const id = line?.id;
    return line?.type === 'session' && typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && name.endsWith(`_${id}.jsonl`) && sameCwd(cwd, line.cwd) ? id : null;
  });
}

export const CLI_TABLE = Object.freeze([
  { cli: 'claude', agents: ['claude', 'claude-code'], resume: 'claude --resume {id}', readyStates: ['idle', 'done'], exit: { keys: ['/', 'e', 'x', 'i', 't', 'enter'], maxAttempts: 1 }, probe: probeClaude },
  { cli: 'codex', agents: ['codex'], resume: 'codex resume {id} --no-daemon', readyStates: ['idle', 'done'], exit: { keys: ['ctrl+c'], maxAttempts: 3 }, probe: probeCodex },
  { cli: 'pi', agents: ['pi'], resume: 'pi --session {id}', readyStates: ['idle', 'done'], exit: { keys: ['ctrl+d'], maxAttempts: 1 }, probe: probePi },
]);
export function lookupCli(terminal) {
  const fields = [terminal?.agent, terminal?.status?.app].filter(v => typeof v === 'string').map(v => v.toLowerCase());
  return CLI_TABLE.find(row => fields.some(field => row.agents.includes(field))) ?? null;
}

// hc may expose an argv vector or a Windows shim command as one argv entry.
// Derive the resume prefix from the table instead of interpreting a shell.
export function resumeSessionId(row, argv = []) {
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = row.resume.slice(0, row.resume.indexOf('{id}')).trim().split(/\s+/);
  const executable = escape(prefix.shift());
  const args = prefix.map(escape).join('\\s+');
  const pattern = new RegExp(`(?:^|[\\s/\\\\"'])${executable}(?:\\.(?:cmd|bat|exe))?["']?\\s+${args}\\s+["']?([a-zA-Z0-9_-]+)(?=["'\\s]|$)`, 'gi');
  const ids = [...String(argv.join(' ')).matchAll(pattern)].map(match => match[1]);
  return new Set(ids).size === 1 ? ids[0] : null;
}
