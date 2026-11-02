import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paneProcess } from './proc.js';
import { readJsonl } from './jsonl.js';

export const projectDirectory = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const realText = text => String(text).replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '').trim();
const command = text => /^\s*(?:<\/?(?:command-name|command-message|command-args|local-command|local-command-stdout|local-command-caveat|task-notification)\b|\[Request interrupted by user)/i.test(text);

export function claudeItems(record, offset = 0) {
  if (record.isMeta || record.isSidechain || record.subtype || !['user', 'assistant'].includes(record.type)) return [];
  const content = record.message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const base = { ts: record.timestamp ?? null, id: String(record.uuid ?? offset) };
  if (record.type === 'user') {
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
  constructor({ home = homedir(), procRoot = '/proc' } = {}) { Object.assign(this, { home, procRoot }); }
  async locate(pane) {
    const pid = await paneProcess(pane.pane_id, 'claude', this.procRoot);
    if (!pid) return null;
    try {
      // Exact .json filename only. Never enumerate or open the adjacent *.key files.
      const { sessionId, cwd, pid: sessionPid } = JSON.parse(await readFile(join(this.home, '.claude', 'sessions', `${pid}.json`), 'utf8'));
      if (Number(sessionPid) !== pid || typeof cwd !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
      const path = join(this.home, '.claude', 'projects', projectDirectory(cwd), `${sessionId}.jsonl`);
      // Validate the actual escaped directory/file rather than guessing another project.
      return (await stat(path)).isFile() ? path : null;
    } catch { return null; }
  }
  // atEnd initializes a binding without reading historical records. Otherwise
  // the cursor is the opaque object returned by the preceding read.
  read(path, cursor) { return readJsonl(path, cursor?.atEnd ? null : cursor, claudeItems, { end: Boolean(cursor?.atEnd) }); }
}
