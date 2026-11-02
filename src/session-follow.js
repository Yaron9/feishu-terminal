import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// All OS effects are injectable. Only numeric *.json session files are opened;
// session payloads are projected immediately and never retained or audited.
export class SessionFollow {
  constructor({ home = homedir(), procRoot = '/proc', read = readFile, names = readdir,
    kill = (pid, signal) => process.kill(pid, signal), sleep = ms => new Promise(r => setTimeout(r, ms)),
    now = Date.now, waitMs = 10000 } = {}) {
    Object.assign(this, { home, procRoot, read, names, kill, sleep, now, waitMs });
  }
  async sessionIdOf(pid) {
    try {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      const { pid: savedPid, sessionId } = JSON.parse(await this.read(join(this.home, '.claude', 'sessions', `${pid}.json`), 'utf8'));
      return savedPid === pid && typeof sessionId === 'string' && /^[a-zA-Z0-9_-]+$/.test(sessionId) ? sessionId : null;
    } catch { return null; }
  }
  async process(pid, sessionId) {
    try {
      if (!Number.isSafeInteger(pid) || pid <= 0 || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
      const base = join(this.procRoot, String(pid));
      const start = async () => {
        const stat = await this.read(join(base, 'stat'), 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
        if (fields[0] === 'Z') return null;
        const value = Number(fields[19]); return Number.isSafeInteger(value) && value > 0 ? value : null;
      };
      const first = await start(); if (!first) return null;
      const { pid: savedPid, sessionId: savedId } = JSON.parse(await this.read(join(this.home, '.claude', 'sessions', `${pid}.json`), 'utf8'));
      if (savedPid !== pid || savedId !== sessionId || (await this.read(join(base, 'comm'), 'utf8')).trim() !== 'claude') return null;
      const env = Object.fromEntries((await this.read(join(base, 'environ'), 'utf8')).split('\0').filter(x => x.includes('='))
        .map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
      if (await start() !== first || (await this.read(join(base, 'comm'), 'utf8')).trim() !== 'claude') return null;
      return { pid, start: first, sessionId, terminalId: env.HC_TERMINAL_ID ? `hc:${env.HC_TERMINAL_ID}` : env.HERDR_PANE_ID ?? null };
    } catch { return null; }
  }
  async candidates(sessionId) {
    let names;
    try { names = await this.names(join(this.home, '.claude', 'sessions')); } catch { return []; }
    const result = [];
    for (const name of names.filter(n => /^\d+\.json$/.test(n))) {
      const candidate = await this.process(Number(name.slice(0, -5)), sessionId);
      if (candidate) result.push(candidate);
    }
    return result.sort((a, b) => b.start - a.start || b.pid - a.pid);
  }
  terminal(candidate, terminals, backend) {
    // Remote terminals have remote /proc namespaces: never match local PIDs.
    const local = terminals.filter(t => !/^hc:[^/]+\//.test(t.pane_id));
    const byEnv = local.find(t => t.pane_id === candidate.terminalId);
    if (byEnv) {
      const pid = backend.processOf(byEnv);
      if (pid && pid !== candidate.pid) return null;
      return byEnv;
    }
    return candidate.terminalId ? null : local.find(t => backend.processOf(t) === candidate.pid) ?? null;
  }
  async alive(candidate) {
    try {
      const stat = await this.read(join(this.procRoot, String(candidate.pid), 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      return fields[0] !== 'Z' && Number(fields[19]) === candidate.start;
    } catch (error) {
      // Disappearing session metadata is not proof the process exited.
      return !['ENOENT', 'ESRCH'].includes(error.code);
    }
  }
  async terminate(older, winner, audit, stillCurrent = () => true) {
    // Audit intent before the final reads. Nothing asynchronous intervenes
    // between re-verification and kill; compare start time against PID reuse.
    await audit({ action: 'session_terminate_intent', pid: older.pid, winner_pid: winner.pid });
    const liveWinner = await this.process(winner.pid, winner.sessionId);
    const current = await this.process(older.pid, older.sessionId);
    if (!stillCurrent() || !liveWinner || liveWinner.start !== winner.start || liveWinner.terminalId !== winner.terminalId ||
        !current || current.start !== older.start || current.start >= liveWinner.start) return { pid: older.pid, outcome: 'unverified' };
    try { this.kill(older.pid, 'SIGTERM'); }
    catch (error) { return { pid: older.pid, outcome: error.code === 'ESRCH' ? 'ended' : 'failed' }; }
    await audit({ action: 'session_terminate', pid: older.pid, winner_pid: winner.pid, signal: 'SIGTERM' });
    const deadline = this.now() + this.waitMs;
    do {
      if (!await this.alive(older)) return { pid: older.pid, outcome: 'ended' };
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(200, deadline - this.now()));
    } while (true);
    return { pid: older.pid, outcome: 'still_alive' };
  }
}
