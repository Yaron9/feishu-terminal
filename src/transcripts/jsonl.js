import { localFiles } from './files.js';

// JSONL streaming over a file port. The port owns the low-level cursor (byte
// offsets and rotation anchors locally, line numbers over hc); this module only
// parses complete lines and projects records. Invalid/non-message lines must
// never reach logs or audit.
export async function cursorAt(files, path, position) {
  return files.seek(path, position);
}

export async function readJsonl(path, cursor, project, { end = false, onReset = () => {}, files = localFiles() } = {}) {
  const { lines, cursor: next } = await files.readFrom(path, cursor, { end, onReset });
  const items = [];
  for (const { text, position } of lines) {
    try { items.push(...project(JSON.parse(text), position)); }
    catch { /* Invalid/non-message lines must never reach logs or audit. */ }
  }
  return { items, cursor: next };
}

// Adapters project one { role: 'model', model } marker per record that names
// the model in use. A read keeps only the latest marker as `model`, so the
// bridge records what the CLI actually ran without seeing model items.
export function splitModel({ items, cursor }) {
  let model = null;
  const messages = [];
  for (const item of items) {
    if (item.role === 'model') { if (item.model) model = item.model; continue; }
    messages.push(item);
  }
  return { items: messages, cursor, ...(model ? { model } : {}) };
}
