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
//   seek(path, position) -> a cursor at `position` (used by locate to skip
//       history up to a known prompt offset).
import { homedir } from 'node:os';
import { readdir, stat, open, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

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
