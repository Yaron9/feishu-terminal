import { stripVTControlCharacters } from 'node:util';

const textOf = r => {
  const c = r.message?.content ?? r.content ?? '';
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text ?? b.content ?? '').join('\n') : '';
};
const short = s => String(s ?? '').replace(/\s+/g, ' ').slice(0, 180);
export const emptyBackground = () => ({ running: [], finished: [], pending: {} });
export function stopBackground(state, restartedAt = null) {
  const cutoff = Date.parse(restartedAt);
  const stopped = state.running.filter(t => !Number.isFinite(cutoff) || !Number.isFinite(Date.parse(t.startedAt)) || Date.parse(t.startedAt) < cutoff);
  state.running = state.running.filter(t => !stopped.includes(t));
  state.finished = [...state.finished, ...stopped.map(t => ({ ...t, status: 'stopped', finishedAt: restartedAt, exitCode: null }))].slice(-5);
  for (const [id, t] of Object.entries(state.pending)) {
    if (!Number.isFinite(cutoff) || !Number.isFinite(Date.parse(t.startedAt)) || Date.parse(t.startedAt) < cutoff) delete state.pending[id];
  }
}
export function trackBackground(state, record) {
  if (record.isSidechain) return;
  const blocks = record.message?.content;
  if (record.type === 'assistant' && Array.isArray(blocks)) for (const b of blocks) {
    if (b.type === 'tool_use' && b.input?.run_in_background) {
      state.pending[b.id] = { description: short(b.input.description ?? b.input.command ?? b.name), tool: short(b.name), startedAt: record.timestamp ?? null };
      if (Object.keys(state.pending).length > 500) delete state.pending[Object.keys(state.pending)[0]];
    }
  }
  const text = textOf(record);
  const results = Array.isArray(blocks) ? blocks.filter(b => b.type === 'tool_result') : [];
  for (const b of results) {
    const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
    const match = /Command running in background with ID:\s*([a-zA-Z0-9_-]+)[\s\S]*?Output is being written to:\s*(\S+)/.exec(body);
    const id = record.toolUseResult?.backgroundTaskId ?? match?.[1];
    const pending = state.pending[b.tool_use_id];
    if (id && pending && !state.running.some(t => t.id === id) && !state.finished.some(t => t.id === id)) {
      state.running.push({ id, ...pending, outputFile: match?.[2] ?? null });
      state.running = state.running.slice(-500);
      delete state.pending[b.tool_use_id];
    }
  }
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const field = name => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(match[1])?.[1];
    const id = field('task-id'), status = field('status');
    if (/previous session ended/i.test(field('summary') ?? '')) stopBackground(state, record.timestamp);
    if (!id || !status) continue;
    const index = state.running.findIndex(t => t.id === id);
    const previous = state.finished.find(t => t.id === id);
    const task = index < 0 ? previous ?? { id, description: short(field('summary')), startedAt: null } : state.running.splice(index, 1)[0];
    state.finished = state.finished.filter(t => t.id !== id);
    const exit = /exit code (-?\d+)/.exec(field('summary') ?? '');
    state.finished.push({ ...task, outputFile: field('output-file') ?? task.outputFile, status, exitCode: exit ? Number(exit[1]) : null, finishedAt: record.timestamp ?? null });
    state.finished = state.finished.slice(-5);
  }
}
export function screenActivity(screen) {
  const lines = stripVTControlCharacters(String(screen)).split(/\r?\n/).map(s => s.trim());
  return { spinner: lines.filter(s => /^[✻✽✶✳✢·*]\s+\S/.test(s) && /(?:…|\.\.\.|\bfor \d+\s*s|tokens|thinking)/i.test(s)).at(-1)?.slice(0, 240) ?? '',
    footerCount: lines.reduce((count, s) => {
      const m = /\b(\d+)\s+(?:shells?|tasks?|agents?)(?:\s+still running)?\b/i.exec(s);
      return m && /auto mode|to manage|still running|done\b/i.test(s) ? Number(m[1]) : count;
    }, lines.some(s => /^(?:⏵⏵\s+auto mode\b|.*(?:bypass permissions|accept edits)\s+(?:on|·)|\?\s+for shortcuts\b|[❯›]\s*$)/i.test(s)) ? 0 : null) };
}
export function backgroundView(background, screen, now) {
  const { footerCount } = screenActivity(screen);
  return { running: background.running.map(t => ({ ...t,
    status: footerCount === 0 && now - Date.parse(t.startedAt) > 60000 ? 'unknown' : 'running',
    minutes: Math.max(0, Math.floor((now - (Number.isFinite(Date.parse(t.startedAt)) ? Date.parse(t.startedAt) : now)) / 60000)),
  })), finished: background.finished };
}
