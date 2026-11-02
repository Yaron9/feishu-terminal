import { open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const WINDOW = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// No retained transcript text in a cursor. Partial lines (including split UTF-8)
// are reread next poll; oversized records are skipped with bounded memory.
export async function readJsonl(path, cursor, project, { end = false } = {}) {
  if (!(await lstat(path)).isFile()) throw new Error('transcript_regular_file_required');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    let offset = cursor?.offset ?? 0, skip = cursor?.skip ?? false;
    async function anchor(at) {
      const bytes = Buffer.alloc(Math.min(64, at));
      await file.read(bytes, 0, bytes.length, at - bytes.length);
      return digest(bytes);
    }
    if (cursor && (cursor.identity !== identity || offset > stat.size || cursor.anchor !== await anchor(offset))) {
      offset = 0; skip = false;
    }
    if (end) {
      offset = stat.size;
      const last = Buffer.alloc(1);
      if (offset) await file.read(last, 0, 1, offset - 1);
      skip = offset > 0 && last[0] !== 10;
    }
    const bytes = Buffer.alloc(end ? 0 : Math.min(WINDOW, Math.max(0, stat.size - offset)));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
    const chunk = bytes.subarray(0, bytesRead), items = [];
    let start = 0, newline;
    while ((newline = chunk.indexOf(10, start)) !== -1) {
      if (!skip) {
        try { items.push(...project(JSON.parse(chunk.subarray(start, newline).toString('utf8')), offset + start)); }
        catch { /* Invalid/non-message lines must never reach logs or audit. */ }
      }
      skip = false; start = newline + 1;
    }
    // Drain a record larger than WINDOW without ever decoding its fragments.
    if (start === 0 && bytesRead === WINDOW) { start = bytesRead; skip = true; }
    offset += start;
    return { items, cursor: { identity, offset, skip, anchor: await anchor(offset) } };
  } finally { await file.close(); }
}
