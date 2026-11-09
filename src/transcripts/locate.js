import { basename } from 'node:path';
import { sameCwd, resumeSessionId, CLI_TABLE } from '../cli-table.js';
import { echoIndex, inputHash } from '../input-echo.js';
import { readJsonl, cursorAt } from './jsonl.js';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
export async function locateSession(files, pane, binding, bindings, sessions, config, now = Date.now()) {
    const root = config.root;
    const held = new Set(bindings.filter(b => b.topicId !== binding.topicId || b.chatId !== binding.chatId).map(b => b.transcript?.path).filter(Boolean));
    const saved = binding.transcript?.adapter === config.key && binding.transcript.path;
    const pending = (binding.sentInputs ?? []).findLast(input => !input.echoChecked && Number.isFinite(input.sentAt) && now - input.sentAt >= 3000 && now <= input.expires);
    let savedValid = false;
    if (saved && !held.has(saved)) {
      const known = sessions.get(saved);
      if (known?.sessionId) {
        savedValid = true;
        if (!pending) return saved;
      } else {
        try {
          if ((await files.stat(saved)).isFile) {
            let meta;
            await readJsonl(saved, null, record => { meta ??= config.meta(record); return []; }, { files });
            if (validId(meta?.id) && config.matchesId(basename(saved), meta.id)) sessions.set(saved, { file: saved, sessionId: meta.id, fresh: false });
            savedValid = true;
            if (!pending) return saved;
          }
        } catch { /* inaccessible saved transcript */ }
      }
    }
    const row = CLI_TABLE.find(r => r.cli === config.key);
    const paneId = pane.labels?.session ?? resumeSessionId(row, pane.foreground?.argv) ?? resumeSessionId(row, pane.argv);
    const id = validId(paneId) ? paneId : (['verified', 'probe'].includes(binding.sessionSource) && validId(binding.sessionId) && !bindings.some(b => (b.topicId !== binding.topicId || b.chatId !== binding.chatId) && b.sessionId === binding.sessionId) ? binding.sessionId : null);
    const cwd = pane.foreground?.cwd ?? pane.foreground_cwd ?? pane.cwd ?? binding.cwd;
    const command = (binding.sentInputs ?? []).findLast(i => i.hash && binding.cliCommand && i.hash === inputHash(binding.cliCommand));
    const since = binding.cliCommandSentAt ?? command?.sentAt;
    if (!savedValid && !id && !Number.isFinite(since)) return null;
    const matches = [];
    const walk = async (dir, depth) => {
      let entries; try { entries = await files.list(dir); } catch { return; }
      for (const entry of entries) {
        const file = files.join(dir, entry.name);
        if (depth && entry.isDirectory && config.directory(entry.name)) { await walk(file, depth - 1); continue; }
        if (depth || !entry.isFile || !config.file(entry.name) || held.has(file) || (!savedValid && id && !config.matchesId(entry.name, id))) continue;
        try {
          if ((savedValid || !id) && (await files.stat(file)).mtimeMs < (savedValid ? pending.sentAt : since)) continue;
          let meta, first, promptOffset;
          let scanCursor = null, previous;
          do {
            previous = scanCursor?.offset ?? 0;
            const scan = await readJsonl(file, scanCursor, (record, offset) => {
            if (!meta && config.meta(record)) meta = config.meta(record);
            if (!first) first = config.items(record).find(item => item.role === 'user');
            if (savedValid && promptOffset === undefined && config.items(record).some(item => item.role === 'user' && Date.parse(item.ts) >= pending.sentAt && echoIndex(item, [pending], now, binding.identity?.terminalId) === 0)) promptOffset = offset;
            return [];
            }, { files });
            scanCursor = scan.cursor;
          } while (scanCursor.offset > previous);
          const sessionId = meta?.id;
          if (!validId(sessionId) || !config.matchesId(basename(file), sessionId) || (!savedValid && id && sessionId !== id) || !sameCwd(cwd, meta.cwd)) continue;
          if (savedValid) {
            if (promptOffset !== undefined) matches.push({ file, sessionId, cursor: await cursorAt(files, file, promptOffset) });
            continue;
          }
          const start = Date.parse(meta.timestamp ?? '');
          if (!id && (!Number.isFinite(start) || start < since || !first || echoIndex(first, [...(binding.sentInputs ?? [])], Date.parse(first.ts) || Date.now(), binding.identity?.terminalId) < 0)) continue;
          matches.push({ file, sessionId, fresh: !id });
        } catch { /* inaccessible or incomplete rollout */ }
      }
    };
    await walk(root, config.depth);
    if (matches.length !== 1) return savedValid ? saved : null;
    if (savedValid && matches[0].file === saved) return saved;
    const match = matches[0]; sessions.set(match.file, match); return match.file;
}
