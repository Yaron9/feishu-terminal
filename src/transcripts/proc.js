import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function paneProcess(paneId, comm, procRoot = '/proc') {
  let entries;
  try { entries = await readdir(procRoot); } catch { return null; }
  const matches = [];
  for (const pid of entries.filter(name => /^\d+$/.test(name))) {
    try {
      const base = join(procRoot, pid);
      if ((await readFile(join(base, 'comm'), 'utf8')).trim() !== comm) continue;
      const env = (await readFile(join(base, 'environ'), 'utf8')).split('\0');
      if (!env.includes(paneId.startsWith('hc:') ? `HC_TERMINAL_ID=${paneId.slice(3)}` : `HERDR_PANE_ID=${paneId}`)) continue;
      const stat = await readFile(join(base, 'stat'), 'utf8');
      const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19]);
      if (Number.isFinite(start)) matches.push({ pid: Number(pid), start });
    } catch { /* Exited or inaccessible process. */ }
  }
  matches.sort((a, b) => b.start - a.start || b.pid - a.pid);
  return matches[0]?.pid ?? null;
}
