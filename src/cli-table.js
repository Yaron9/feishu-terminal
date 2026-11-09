import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join, win32, posix } from 'node:path';
import { safeModelValue } from './group-model.js';

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
  // Ambiguity only blocks the unowned claim path. Candidates stay available so
  // each binding can identify its own session by the exact text ft sent into
  // its own pane (sentTextMatch, used by wake.observe).
  if (matches.length > 1) return { sessionId: null, source: null, reason: 'ambiguous', candidates: matches };
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
        try { const line = await firstLine(file), id = parse(line, entry.name, options.cwd); if (id) { const startedAt = Date.parse(line.timestamp ?? line.payload?.timestamp ?? ''); matches.push({ sessionId: id, source: file, ...(Number.isFinite(startedAt) ? { startedAt } : {}) }); } } catch { /* incomplete or invalid session */ }
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

// Explicit navigation chrome lets selection screens remain usable when a CLI
// reports idle. Prose questions and ordinary input prompts never match this.
const menuScreen = screen => {
  if (/(?:Esc(?:ape)?\s+to\s+(?:cancel|close|exit|go back)|[↑↓].*(?:navigate|select))/i.test(screen) &&
      /(?:resume session|select (?:a )?(?:model|session|option)|settings|configuration|allow this command|do you want to proceed|would you like to run)/i.test(screen)) return true;
  const lines = screen.split('\n');
  const footer = lines.findLastIndex(line => /(?:\benter\s+(?:to\s+)?\w+.*\besc(?:ape)?\s+(?:to\s+)?\w+|[↑↓].*(?:browse|navigate))/i.test(line));
  return footer >= 0 && lines.slice(0, footer).some(line => /^\s*[❯›>→]\s+\S/u.test(line)) &&
    lines.slice(footer + 1).every(line => !line.trim() || /[↑↓].*(?:browse|navigate)/i.test(line));
};
// `model` is the remembered-model template per row. Each segment is appended
// whole or dropped whole: a pi model recorded without a provider still yields
// just `--model X`, and an unrecorded codex effort adds no `-c` segment.
export const CLI_TABLE = Object.freeze([
  { cli: 'claude', launch: 'claude', model: ['--model {model}'], footerPatterns: [/^\s*⏵⏵.*(?:mode|interrupt)/i, /^\s*\? for shortcuts/i], agents: ['claude', 'claude-code'], resume: 'claude --resume {id}', readyStates: ['idle', 'done', 'error'], exit: { keys: ['/', 'e', 'x', 'i', 't', 'enter'], maxAttempts: 1 }, probe: probeClaude },
  { cli: 'codex', launch: 'codex --no-daemon -c check_for_update_on_startup=false', model: ['-m {model}', '-c model_reasoning_effort={effort}'], backgroundScreen: /\b[1-9]\d* background terminals? running\b/i, footerPatterns: [/^\s*\? for shortcuts(?:\s|$)/i, /^\s*[^\n]*\s·\s(?:[A-Za-z]:[\\/]|~[\\/]|\/).*$/], agents: ['codex'], resume: 'codex resume {id} --no-daemon -c check_for_update_on_startup=false', readyStates: ['idle', 'done', 'error'], exit: { keys: ['ctrl+c'], maxAttempts: 3 }, probe: probeCodex },
  { cli: 'pi', launch: 'pi', instructions: '--append-system-prompt {file}', model: ['--provider {provider}', '--model {model}'], footerPatterns: [/^\s*\d+(?:\.\d+)?%\/\S+.*(?:model|•)/i], agents: ['pi'], resume: 'pi --session {id}', readyStates: ['idle', 'done', 'error'], exit: { keys: ['ctrl+d'], maxAttempts: 1 }, probe: probePi },
]);
for (const row of CLI_TABLE) row.menuScreen = menuScreen;

// The launch command is a `line` that herdr-core runs via cmd.exe on Windows
// (`%COMSPEC% /d /s /c`) and `sh -c` elsewhere. Only double quotes group an
// argument in cmd.exe; Windows paths cannot contain `"`, so no escaping is
// needed there. POSIX keeps single quotes and the standard `'\''` escape.
export function shellQuote(value) {
  return process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}
// The row's instructions template, applied only when the file really exists.
// Rows without `instructions` (codex, claude) are never modified: their
// persona comes from AGENTS.md/CLAUDE.md in the cwd.
export async function instructionsArg(row, file) {
  if (!row?.instructions || !file) return null;
  try { await stat(file); } catch { return null; }
  return row.instructions.replace('{file}', shellQuote(file));
}
// Render the remembered model through the row's template. Only safe model
// identifiers (no shell metacharacters) ever reach the command line.
export function modelArgs(row, remembered) {
  if (!row?.model || !remembered) return '';
  const values = { model: safeModelValue(remembered.model), provider: safeModelValue(remembered.provider), effort: safeModelValue(remembered.effort) };
  return row.model
    .filter(segment => [...segment.matchAll(/\{(\w+)\}/g)].every(match => Boolean(values[match[1]])))
    .map(segment => segment.replace(/\{(\w+)\}/g, (_match, name) => values[name]))
    .join(' ');
}
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
