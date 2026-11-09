import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { freemem, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const STALE_MS = 45 * 60 * 1000;
const MIN_AVAILABLE_BYTES = 450 * 1024 * 1024;
const windows = [['fiveHour', '五小时'], ['sevenDay', '每周']];

async function memoryAvailable() {
  if (platform() !== 'linux') return freemem() >= MIN_AVAILABLE_BYTES;
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
    return Boolean(match && Number(match[1]) * 1024 >= MIN_AVAILABLE_BYTES);
  } catch { return false; }
}

async function runCswap() {
  const command = platform() === 'win32' ? 'cswap.exe' : join(homedir(), '.local', 'bin', 'cswap');
  const { stdout } = await exec(command, ['list', '--json'], {
    timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  return JSON.parse(stdout);
}

function timeLabel(value) {
  if (typeof value !== 'string') return '未知';
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return '未知';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour12: false,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(stamp);
  const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${fields.month}-${fields.day} ${fields.hour}:${fields.minute} 北京时间`;
}

function maskedEmail(value) {
  if (typeof value !== 'string') return '未标识账号';
  const match = /^([^\s@])[^\s@]*@([a-z0-9.-]+)$/iu.exec(value);
  return match ? `${match[1]}***@${match[2]}` : '未标识账号';
}

function safePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ?
    Math.round((100 - value) * 10000) / 10000 : null;
}

export function formatUsage(payload, now = Date.now(), forceStale = false) {
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.accounts)) throw new Error('invalid usage data');
  const accounts = payload.accounts.filter(a => a && typeof a === 'object' && !Array.isArray(a));
  if (!accounts.length) return 'Claude 额度：cswap 尚无已登记账号。';
  const lines = [`Claude 额度（已识别 ${accounts.length} 个账号；订阅余量百分比，非 token 数）：`];
  for (const account of accounts) {
    const ok = account.usageStatus === 'ok';
    const when = ok ? account.usageFetchedAt : account.lastGoodFetchedAt;
    const timestamp = typeof when === 'string' ? Date.parse(when) : NaN;
    const age = now - timestamp;
    const fresh = !forceStale && ok && Number.isFinite(timestamp) && age >= -300000 && age <= STALE_MS;
    const data = ok ? account.usage : account.lastGoodUsage;
    const safeData = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const number = Number.isSafeInteger(account.number) && account.number > 0 ? `#${account.number} ` : '';
    const state = account.usageStatus === 'relogin_required' ? '需要重新登录' : fresh ? '近期数据' : '实时性待确认';
    lines.push(`  ${number}${maskedEmail(account.email)} · ${state} · 更新 ${timeLabel(when)}`);
    for (const [key, label] of windows) {
      const window = safeData[key];
      const remaining = window && typeof window === 'object' ? safePercent(window.pct) : null;
      if (remaining === null) lines.push(`    ${label}额度暂不可用`);
      else lines.push(`    ${label}剩余 ${remaining}% · 重置 ${timeLabel(window.resetsAt)}`);
    }
  }
  return lines.join('\n');
}

// Cache and coalesce requests in this process. Never log cswap output or errors:
// the JSON includes account identifiers and failures may contain private data.
export function createUsageReader({ run = runCswap, now = Date.now, memory = memoryAvailable,
  cacheMs = 60000 } = {}) {
  let cached = null, fetchedAt = -Infinity, pending = null;
  return async function readUsage() {
    if (cached && now() - fetchedAt >= 0 && now() - fetchedAt < cacheMs) return formatUsage(cached, now());
    if (pending) return pending;
    pending = (async () => {
      try {
        if (!await memory()) throw new Error('insufficient memory');
        const payload = await run();
        const text = formatUsage(payload, now());
        cached = payload; fetchedAt = now();
        return text;
      } catch {
        return cached ? formatUsage(cached, now(), true) : 'Claude 额度暂时无法读取，请稍后重试或检查 cswap。';
      }
    })();
    try { return await pending; } finally { pending = null; }
  };
}
