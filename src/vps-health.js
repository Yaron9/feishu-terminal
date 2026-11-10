import { readFile, readdir, statfs, mkdir, open, rename, chmod } from 'node:fs/promises';
import { homedir, platform, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

const MIB = 1024 * 1024;
const PRESSURE_WINDOW_MS = 10000, PRESSURE_US = 3000000, PRESSURE_RECOVERY_MS = 300000;
const SCAN_MS = 300000, POLL_MS = 1000;
const readText = async path => { try { return await readFile(path, 'utf8'); } catch { return null; } };
const readOptional = async path => { try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

export function parseMeminfo(text) {
  if (typeof text !== 'string') return null;
  const values = {};
  for (const line of text.split('\n')) {
    const m = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB$/.exec(line);
    if (m) values[m[1]] = Math.floor(Number(m[2]) / 1024);
  }
  return ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'].every(k => Number.isFinite(values[k])) ? values : null;
}
export function parsePsiTotal(text) {
  const m = typeof text === 'string' && /^some\s+[^\n]*\btotal=(\d+)/m.exec(text);
  return m ? Number(m[1]) : null;
}
export function parseOom(text) {
  const m = typeof text === 'string' && /^oom_kill\s+(\d+)\s*$/m.exec(text);
  return m ? Number(m[1]) : null;
}
export function parseLegacyState(text) {
  const result = {};
  for (const line of (text ?? '').split('\n')) {
    const m = /^([a-z_]+)=([0-9,]*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'zombies') result.zombies = m[2].split(',').filter(Boolean).map(Number);
    else if (m[2] !== '') result[m[1]] = Number(m[2]);
  }
  return result;
}

export async function collectSystem() {
  if (platform() !== 'linux') return null;
  const [memoryText, pressure, vmstat, load] = await Promise.all([
    readText('/proc/meminfo'), readText('/proc/pressure/memory'), readText('/proc/vmstat'), readText('/proc/loadavg'),
  ]);
  const memory = parseMeminfo(memoryText);
  let disk = null, zombies = [], inaccessible = 0, procCount = 0, running = 0, claude = 0;
  try {
    const f = await statfs('/'); const used = Number(f.blocks - f.bfree), avail = Number(f.bavail);
    if (used + avail > 0) disk = 100 * used / (used + avail);
  } catch { /* unavailable */ }
  try {
    const entries = (await readdir('/proc')).filter(x => /^\d+$/.test(x)); procCount = entries.length;
    for (let i = 0; i < entries.length; i += 32) {
      await Promise.all(entries.slice(i, i + 32).map(async pid => {
        const s = await readText(`/proc/${pid}/stat`);
        if (!s) { inaccessible++; return; }
        const m = /^\d+ \((.*)\) ([A-Z]) /.exec(s);
        if (!m) { inaccessible++; return; }
        if (m[2] === 'Z') zombies.push(Number(pid));
        if (m[2] === 'R') running++;
        if (m[1] === 'claude') claude++;
      }));
    }
  } catch { inaccessible++; }
  const avg10 = typeof pressure === 'string' ? /^some\s+avg10=([\d.]+)/m.exec(pressure)?.[1] : null;
  return { memory, pressureTotal: parsePsiTotal(pressure), pressureAvg10: avg10 ?? null,
    oomSystem: parseOom(vmstat), load: typeof load === 'string' ? load.split(' ').slice(0, 3).join(' / ') : null,
    diskPercent: disk, zombies: zombies.sort((a,b) => a-b), inaccessible, procCount, running, claude };
}

export async function readTraffic({ now = new Date(), database = '/var/lib/vnstat/vnstat.db' } = {}) {
  if (platform() !== 'linux') return null;
  let db;
  try {
    const route = await readText('/proc/net/route');
    const row = route?.split('\n').slice(1).map(line => line.trim().split(/\s+/)).find(fields => fields[1] === '00000000');
    const iface = row?.[0]; if (!iface) return null;
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(database, { readOnly: true });
    const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const data = db.prepare('SELECT i.name,i.created,i.updated,m.rx,m.tx FROM interface i LEFT JOIN month m ON m.interface=i.id AND m.date=? WHERE i.name=?').get(month, iface);
    if (!data || !Number.isFinite(data.rx) || !Number.isFinite(data.tx)) return null;
    return { iface: data.name, created: data.created, updated: data.updated, rx: data.rx, tx: data.tx };
  } catch { return null; } finally { db?.close(); }
}

export function formatStatus(metrics, traffic, usage) {
  const lines = ['VPS 状态（实时采集）'];
  if (metrics?.memory) {
    const m = metrics.memory;
    lines.push(`内存：可用 ${m.MemAvailable} / ${m.MemTotal} MiB，已用约 ${m.MemTotal-m.MemAvailable} MiB。`);
    lines.push(`交换空间：已用 ${m.SwapTotal-m.SwapFree} / ${m.SwapTotal} MiB。`);
  } else lines.push('内存：暂不可用。');
  if (metrics?.pressureAvg10 !== null && metrics?.pressureAvg10 !== undefined) lines.push(`内存压力：最近 10 秒平均 ${metrics.pressureAvg10}%。`);
  if (Number.isFinite(metrics?.diskPercent)) lines.push(`根磁盘：已用 ${metrics.diskPercent.toFixed(1)}%。`);
  if (traffic) {
    const gib = n => (n / 1024 ** 3).toFixed(2);
    lines.push(`本月网卡流量（${traffic.iface}）：入站 ${gib(traffic.rx)} GiB，出站 ${gib(traffic.tx)} GiB。`);
    lines.push(`统计自 ${traffic.created} 起，更新 ${traffic.updated}；这是网卡统计，不等同 AWS 计费。`);
  } else lines.push('本月网卡流量：暂不可用。');
  lines.push('VPS 套餐总量、账单到期：未接入 AWS 账单，暂不可用。');
  lines.push(typeof usage === 'string' && usage.trim() ? usage : 'Claude 额度：暂不可用。');
  lines.push('模型订阅到期日：数据源未提供；额度重置时间见上方。');
  return lines.join('\n');
}

async function persist(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`; let f;
  try {
    f = await open(temp, 'w', 0o600); await f.writeFile(JSON.stringify(state)); await f.sync(); await f.close(); f = null;
    await chmod(temp, 0o600); await rename(temp, path);
  } finally { await f?.close().catch(() => {}); }
}

export class HealthEngine {
  constructor({ state = {}, send, save = async () => {}, now = () => performance.now() }) {
    this.state = state; this.send = send; this.save = save; this.now = now;
    this.pressureSamples = []; this.pressureActive = false; this.lastPressure = 0;
  }
  async transition(key, bad, recovered, alert, recovery) {
    const active = Boolean(this.state[key]);
    const next = bad && !active ? 1 : active && recovered ? 0 : null;
    if (next === null) return;
    try { await this.send(next ? alert : recovery); this.state[key] = next; }
    catch { /* retry on the next observation; never include API errors in output */ }
  }
  async scan(m) {
    const s = this.state, mem = m.memory?.MemAvailable;
    s.low_samples = Number.isFinite(mem) && mem < 300 ? (s.low_samples || 0) + 1 : 0;
    s.recovery_samples = Number.isFinite(mem) && mem >= 450 ? (s.recovery_samples || 0) + 1 : 0;
    if (Number.isFinite(mem)) await this.transition('low_memory',s.low_samples>=2,s.recovery_samples>=2,
      `[VPS 健康提醒] 可用内存连续两次检查低于 300 MiB，当前 ${mem} MiB。`,
      `[VPS 健康恢复] 可用内存连续两次检查达到 450 MiB，当前 ${mem} MiB。`);
    const previous = new Set(Array.isArray(s.zombies) ? s.zombies : []);
    const current = Array.isArray(m.zombies) ? m.zombies : [];
    const persistent = current.filter(pid => previous.has(pid)); s.zombies = current;
    await this.transition('zombie_alert',persistent.length>0,current.length===0 && !m.inaccessible,
      `[VPS 健康提醒] 发现持续存在的僵尸进程 ${persistent.length} 个，PID: ${persistent.slice(0,10).join(', ')}。`,
      '[VPS 健康恢复] 上次发现的僵尸进程已消失。');
    if (Number.isFinite(m.diskPercent)) await this.transition('disk_alert',m.diskPercent>=90,m.diskPercent<85,
      `[VPS 健康提醒] 根磁盘使用率达到 ${m.diskPercent.toFixed(1)}%。`,
      `[VPS 健康恢复] 根磁盘使用率降至 ${m.diskPercent.toFixed(1)}%。`);
    await this.save(s);
  }
  async oom(value) {
    if (!Number.isSafeInteger(value) || value < 0) return;
    const old = this.state.oom_kill;
    if (!Number.isSafeInteger(old) || value < old) this.state.oom_kill = value;
    else if (value > old) {
      try { await this.send(`[VPS 健康提醒] 用户进程所在 cgroup 新增 ${value-old} 次 OOM 终止。`); this.state.oom_kill = value; }
      catch { /* retry */ }
    }
    await this.save(this.state);
  }
  async pressure(total, mem) {
    if (!Number.isSafeInteger(total) || total < 0) return;
    const now = this.now(), samples = this.pressureSamples;
    if (samples.length && (total < samples.at(-1).total || now < samples.at(-1).at)) samples.length = 0;
    samples.push({ at: now, total });
    while (samples.length > 1 && samples[1].at <= now-PRESSURE_WINDOW_MS) samples.shift();
    const start = samples[0];
    const isPressure = samples.length > 1 && now-start.at <= PRESSURE_WINDOW_MS+POLL_MS && total-start.total >= PRESSURE_US;
    if (isPressure) {
      this.lastPressure = now;
      if (!this.pressureActive) {
        try { await this.send(`[VPS 健康提醒] 内存压力偏高：10 秒内任务因内存等待累计至少 3 秒；当前可用内存 ${Number.isFinite(mem) ? `${mem} MiB` : '暂不可用'}。`); this.pressureActive = true; }
        catch { /* retry */ }
      }
    } else if (this.pressureActive && now-this.lastPressure >= PRESSURE_RECOVERY_MS) {
      try { await this.send('[VPS 健康恢复] 内存压力事件已平息超过 5 分钟。'); this.pressureActive = false; }
      catch { this.lastPressure = now; }
    }
  }
}

export async function startHealthMonitor({ send, stateDir = join(homedir(),'.local/state/feishu-terminal'),
  legacyPath = join(homedir(),'.local/state/vps-health-guard/state-v2.txt'), onError = () => {}, onHealthy = () => {} } = {}) {
  if (platform() !== 'linux') return { stop: async () => {} };
  if (typeof send !== 'function') throw new TypeError('send is required');
  const path = join(stateDir,'health-monitor.json');
  let state = {}; const saved = await readOptional(path);
  if (saved !== null) { try { state = JSON.parse(saved); if (!state || Array.isArray(state) || typeof state !== 'object') throw new Error(); } catch { throw new Error('health state unreadable'); } }
  else state = parseLegacyState(await readOptional(legacyPath));
  let pendingSave = Promise.resolve();
  const save = value => { pendingSave = pendingSave.catch(() => {}).then(() => persist(path,value)); return pendingSave; };
  const engine = new HealthEngine({ state, send, save });
  const uid = userInfo().uid, oomPath = `/sys/fs/cgroup/user.slice/user-${uid}.slice/memory.events`;
  let stopped = false, running = false, activeTick = null, lastScan = -Infinity, sourcesHealthy = null, scanHealthy = true;
  const tick = async () => {
    if (stopped || running) return; running = true;
    try {
      const now = performance.now();
      const [psi, oom, mem] = await Promise.all([readText('/proc/pressure/memory'), readText(oomPath), readText('/proc/meminfo')]);
      const memory = parseMeminfo(mem), pressure = parsePsiTotal(psi), n = parseOom(oom);
      const ok = Boolean(memory) && pressure !== null && n !== null;
      if (ok !== sourcesHealthy) { sourcesHealthy = ok; if (!ok) onError('health_source_unavailable'); }
      await engine.pressure(pressure, memory?.MemAvailable);
      if (n !== null && n !== engine.state.oom_kill) await engine.oom(n);
      if (now-lastScan >= SCAN_MS) {
        lastScan = now;
        try { await engine.scan(await collectSystem()); scanHealthy = true; } catch (error) { scanHealthy = false; throw error; }
      }
      if (ok && scanHealthy) onHealthy();
    } catch { onError('health_monitor_failed'); }
    finally { running = false; }
  };
  const launch = () => {
    if (stopped || activeTick) return;
    activeTick = tick().catch(() => onError('health_monitor_failed')).finally(() => { activeTick = null; });
  };
  launch();
  const timer = setInterval(launch,POLL_MS); timer.unref();
  return { stop: async () => { stopped=true; clearInterval(timer); await activeTick?.catch(() => {}); await pendingSave.catch(() => {}); } };
}
