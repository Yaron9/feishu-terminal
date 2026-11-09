// The transcript file port. Transcript adapters (claude, codex, pi), the
// session locator and jsonl reader all read files through one of these ports
// instead of importing node:fs directly, so a remote machine's transcripts can
// be read through hc while the local path keeps byte-accurate behaviour.
//
// A port exposes:
//   home            string (local) or Promise<string> (remote) — await it.
//   list(dir)       -> [{ name, isDirectory, isFile }]
//   stat(path)      -> { isFile, isDirectory, size, mtimeMs, dev, ino, birthtimeMs }
//   readFile(path)  -> utf8 string (whole file; small session JSONs only)
//   readFrom(path, cursor, { end, onReset }) -> { lines: [{ text, position }], cursor }
//       reads complete lines incrementally; `cursor` is opaque to callers and
//       is passed back unchanged. `end` starts from EOF (never replays history).
//   scan(root, depth, { since, directory, file }) -> [{ path, name, mtimeMs, size }]
//       walks `root` up to `depth` in one pass and returns every file matching
//       the name filters with mtimeMs >= since. `directory`/`file` are regex
//       sources (empty means match all), so filters cross the wire as data.
//   seek(path, position) -> a cursor at `position` (used by locate to skip
//       history up to a known prompt offset).
import { homedir } from 'node:os';
import { readdir, stat, open, readFile, lstat } from 'node:fs/promises';
import { join as pathJoin, posix } from 'node:path';
import { createHash } from 'node:crypto';

// One `hc exec --on m node -e ...` program that lists directories, stats files
// and prints the home directory as JSON/plain text. It is run with argv (no
// shell) so argument quoting cannot leak into the command line.
const STAT_SCRIPT = `const fs = require('fs');
const [cmd, arg] = process.argv.slice(1);
if (cmd === 'list') {
  const entries = fs.readdirSync(arg, { withFileTypes: true });
  process.stdout.write(JSON.stringify(entries.map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }))));
} else if (cmd === 'stat') {
  const s = fs.statSync(arg);
  process.stdout.write(JSON.stringify({ isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs }));
} else if (cmd === 'home') {
  process.stdout.write(require('os').homedir());
}`;

// One `hc exec --on m node -e ...` program that walks a tree in a single pass
// and prints every candidate session file as JSON. `directory` and `file` are
// regex sources (empty means "match all") so a filter can cross the wire as
// data instead of a function.
const SCAN_SCRIPT = `const fs = require('fs');
const path = require('path');
const [root, depthStr, sinceStr, dirSrc, fileSrc] = process.argv.slice(2);
const depth = Number(depthStr), since = Number(sinceStr);
const dirRe = dirSrc ? new RegExp(dirSrc) : null;
const fileRe = fileSrc ? new RegExp(fileSrc) : null;
const out = [];
(function walk(dir, remaining) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (remaining > 0 && (!dirRe || dirRe.test(e.name))) walk(p, remaining - 1);
    } else if (e.isFile() && remaining === 0 && (!fileRe || fileRe.test(e.name))) {
      try {
        const s = fs.statSync(p);
        if (s.mtimeMs >= since) out.push({ path: p, name: e.name, mtimeMs: s.mtimeMs, size: s.size });
      } catch { /* unstat-able candidate */ }
    }
  }
})(root, depth);
process.stdout.write(JSON.stringify(out));`;

const WINDOW = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identityOf = s => `${s.dev}:${s.ino}:${s.birthtimeMs}`;

export function localFiles({ home = homedir() } = {}) {
  async function anchorAt(file, at) {
    const bytes = Buffer.alloc(Math.min(64, at));
    if (bytes.length) await file.read(bytes, 0, bytes.length, at - bytes.length);
    return digest(bytes);
  }
  return {
    home,
    join: (...parts) => pathJoin(...parts),
    async list(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
    },
    async stat(path) {
      const s = await stat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size,
        mtimeMs: s.mtimeMs, dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs };
    },
    async readFile(path) { return readFile(path, 'utf8'); },
    async scan(root, depth, { since = 0, directory = null, file = null } = {}) {
      const dirRe = directory ? new RegExp(directory) : null;
      const fileRe = file ? new RegExp(file) : null;
      const out = [];
      const walk = async (dir, remaining) => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const path = pathJoin(dir, entry.name);
          if (entry.isDirectory()) {
            if (remaining > 0 && (!dirRe || dirRe.test(entry.name))) await walk(path, remaining - 1);
          } else if (entry.isFile() && remaining === 0 && (!fileRe || fileRe.test(entry.name))) {
            try {
              const s = await stat(path);
              if (s.mtimeMs >= since) out.push({ path, name: entry.name, mtimeMs: s.mtimeMs, size: s.size });
            } catch { /* unstat-able candidate */ }
          }
        }
      };
      await walk(root, depth);
      return out;
    },
    async seek(path, position) {
      const file = await open(path, 'r');
      try {
        const s = await file.stat();
        return { identity: identityOf(s), offset: position, skip: false, anchor: await anchorAt(file, position) };
      } finally { await file.close(); }
    },
    async readFrom(path, cursor, { end = false, onReset = () => {} } = {}) {
      if (!(await lstat(path)).isFile()) throw new Error('transcript_regular_file_required');
      const file = await open(path, 'r');
      try {
        const s = await file.stat();
        const identity = identityOf(s);
        let offset = cursor?.offset ?? 0, skip = cursor?.skip ?? false;
        const anchor = at => anchorAt(file, at);
        if (cursor && (cursor.identity !== identity || offset > s.size || cursor.anchor !== await anchor(offset))) {
          offset = 0; skip = false; onReset();
        }
        if (end) {
          offset = s.size;
          const last = Buffer.alloc(1);
          if (offset) await file.read(last, 0, 1, offset - 1);
          skip = offset > 0 && last[0] !== 10;
        }
        const bytes = Buffer.alloc(end ? 0 : Math.min(WINDOW, Math.max(0, s.size - offset)));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
        const chunk = bytes.subarray(0, bytesRead), lines = [];
        let start = 0, newline;
        while ((newline = chunk.indexOf(10, start)) !== -1) {
          if (!skip) lines.push({ text: chunk.subarray(start, newline).toString('utf8'), position: offset + start });
          skip = false; start = newline + 1;
        }
        // Drain a record larger than WINDOW without ever decoding its fragments.
        if (start === 0 && bytesRead === WINDOW) { start = bytesRead; skip = true; }
        offset += start;
        return { lines, cursor: { identity, offset, skip, anchor: await anchor(offset) } };
      } finally { await file.close(); }
    },
  };
}

// A port over another machine's files, through the hc core that ft already
// talks to. `client` is the hc backend's client (src/backends/hc.js HcClient);
// every read is one RPC, and `hc file read` is line based, so the cursor is a
// line number per file rather than a byte offset.
export function hcFiles(machine, client, { scanTtl = 1000 } = {}) {
  const decode = b64 => Buffer.from(b64 ?? '', 'base64').toString('utf8');
  const execNode = async argv => {
    const result = await client.request('machine.exec', { argv, on: machine });
    if (result.code !== 0) {
      const error = new Error(decode(result.stderr) || 'hc_exec_failed');
      error.code = 'hc_exec_failed'; throw error;
    }
    return decode(result.stdout);
  };
  let homePromise;
  const home = () => { homePromise ??= execNode(['node', '-e', STAT_SCRIPT, 'home']); return homePromise; };
  // A per-machine scan cache keeps locate cheap while a binding has no verified
  // session: within one poll interval the same tree scan is reused instead of
  // starting another node process on the remote machine.
  let scanCache = null;
  return {
    get home() { return home(); },
    join: (...parts) => posix.join(...parts),
    async list(dir) { return JSON.parse(await execNode(['node', '-e', STAT_SCRIPT, 'list', dir])); },
    async stat(path) { return JSON.parse(await execNode(['node', '-e', STAT_SCRIPT, 'stat', path])); },
    async scan(root, depth, { since = 0, directory = null, file = null } = {}) {
      const dirSrc = directory ?? '', fileSrc = file ?? '';
      const key = JSON.stringify([root, depth, since, dirSrc, fileSrc]);
      const at = Date.now();
      if (scanCache && scanCache.key === key && at - scanCache.at < scanTtl) return scanCache.result;
      const stdout = await execNode(['node', '-e', SCAN_SCRIPT, 'scan', root, String(depth), String(since), dirSrc, fileSrc]);
      const result = JSON.parse(stdout);
      scanCache = { key, at, result };
      return result;
    },
    async readFile(path) { return (await client.request('file.read', { path, on: machine })).text; },
    async seek(path, position) { return { offset: position }; },
    async readFrom(path, cursor, { end = false, onReset = () => {} } = {}) {
      let position = cursor?.offset ?? 1;
      if (end) {
        // Total line count without fetching any content: start just past EOF.
        const probe = await client.request('file.read', { path, on: machine, offset: 1, limit: 0 });
        return { lines: [], cursor: { offset: probe.lines + 1 } };
      }
      let result;
      try {
        result = await client.request('file.read', { path, on: machine, offset: position });
      } catch (error) {
        // offset past EOF: an append-only session has no new lines yet. Never
        // re-read the whole file; keep the cursor where it is.
        if (error.code === 'invalid_params' && position > 1) return { lines: [], cursor };
        throw error;
      }
      const { text, first, last } = result;
      // A trailing partial line at EOF must be reread once it is completed.
      const partialTrailing = last >= first && text !== '' && !text.endsWith('\n');
      let parts = text === '' ? [] : text.split('\n');
      if (text.endsWith('\n')) parts = parts.slice(0, -1);
      const entries = parts.map((line, i) => ({ text: line, position: first + i }));
      const next = partialTrailing ? last : (last >= first ? last + 1 : position);
      return { lines: entries, cursor: { offset: next } };
    },
  };
}
