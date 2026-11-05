import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { sameCwd, resumeSessionId, CLI_TABLE } from '../cli-table.js';
import { echoIndex, inputHash } from '../input-echo.js';
import { readJsonl } from './jsonl.js';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
export async function locateSession(pane, binding, bindings, sessions, config) {
    if (/^hc:[^/]+\//.test(pane.pane_id ?? '')) return null;
    const root = config.root;
    const held = new Set(bindings.filter(b => b.topicId !== binding.topicId || b.chatId !== binding.chatId).map(b => b.transcript?.path).filter(Boolean));
    const saved = binding.transcript?.adapter === config.key && binding.transcript.path;
    if (saved && !held.has(saved)) {
      try {
        if ((await stat(saved)).isFile()) {
          let meta;
          await readJsonl(saved, null, record => { meta ??= config.meta(record); return []; });
          if (validId(meta?.id) && config.matchesId(basename(saved), meta.id)) sessions.set(saved, { file: saved, sessionId: meta.id, fresh: false });
          return saved;
        }
      } catch { /* inaccessible saved transcript */ }
    }
    const row = CLI_TABLE.find(r => r.cli === config.key);
    const paneId = pane.labels?.session ?? resumeSessionId(row, pane.foreground?.argv) ?? resumeSessionId(row, pane.argv);
    const id = validId(paneId) ? paneId : (['verified', 'probe'].includes(binding.sessionSource) && validId(binding.sessionId) && !bindings.some(b => (b.topicId !== binding.topicId || b.chatId !== binding.chatId) && b.sessionId === binding.sessionId) ? binding.sessionId : null);
    const cwd = pane.foreground?.cwd ?? pane.foreground_cwd ?? pane.cwd ?? binding.cwd;
    const command = (binding.sentInputs ?? []).findLast(i => i.hash && binding.cliCommand && i.hash === inputHash(binding.cliCommand));
    const since = binding.cliCommandSentAt ?? command?.sentAt;
    if (!id && !Number.isFinite(since)) return null;
    const matches = [];
    const walk = async (dir, depth) => {
      let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const file = join(dir, entry.name);
        if (depth && entry.isDirectory() && config.directory(entry.name)) { await walk(file, depth - 1); continue; }
        if (depth || !entry.isFile() || !config.file(entry.name) || held.has(file) || (id && !config.matchesId(entry.name, id))) continue;
        try {
          if (!id && (await stat(file)).mtimeMs < since) continue;
          let meta, first;
          await readJsonl(file, null, record => {
            if (!meta && config.meta(record)) meta = config.meta(record);
            if (!first) first = config.items(record).find(item => item.role === 'user');
            return [];
          });
          const sessionId = meta?.id;
          if (!validId(sessionId) || !config.matchesId(basename(file), sessionId) || (id && sessionId !== id) || !sameCwd(cwd, meta.cwd)) continue;
          const start = Date.parse(meta.timestamp ?? '');
          if (!id && (!Number.isFinite(start) || start < since || !first || echoIndex(first, [...(binding.sentInputs ?? [])], Date.parse(first.ts) || Date.now(), binding.identity?.terminalId) < 0)) continue;
          matches.push({ file, sessionId, fresh: !id });
        } catch { /* inaccessible or incomplete rollout */ }
      }
    };
    await walk(root, config.depth);
    if (matches.length !== 1) return null;
    const match = matches[0]; sessions.set(match.file, match); return match.file;
}
