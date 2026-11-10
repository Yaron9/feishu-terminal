import { createHash } from 'node:crypto';
import { readFile, mkdir, open, chmod, rename, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const STALE_MS = 45 * 60 * 1000, INTERVAL_MS = 15 * 60 * 1000;
const WINDOWS = [['fiveHour','5 hours'],['sevenDay','7 days']];
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const windowLabel = name => ({ '5 hours':'五小时', '7 days':'每周' })[name] ?? name;
const mask = value => { const [name, ...rest] = value.split('@'); return rest.length ? `${name.slice(0,1)||'*'}***@${rest.join('@')}` : `${name.slice(0,1)}***`; };
export function timeLabel(value) {
  const t = parse(value); if (t === null) return '未知';
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(t);
  const f = Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${f.month}-${f.day} ${f.hour}:${f.minute} 北京时间`;
}
export function normalizeQuota(raw, now = Date.now()) {
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.accounts)) throw new Error('invalid quota data');
  const items = raw.accounts.filter(x => x && typeof x === 'object' && !Array.isArray(x) && typeof x.email === 'string' && x.email);
  const counts = new Map();for (const a of items) counts.set(a.email.toLowerCase(),(counts.get(a.email.toLowerCase())||0)+1);
  return items.map(a => {
    const identity = a.email.toLowerCase(), org = typeof a.organizationUuid === 'string' ? a.organizationUuid.toLowerCase() : '';
    const legacyId = hash(identity), id = org ? hash(`${identity}\0${org}`) : legacyId;
    const ok = a.usageStatus === 'ok', readAt = ok ? a.usageFetchedAt : a.lastGoodFetchedAt;
    const timestamp = parse(readAt), age = timestamp === null ? null : now - timestamp;
    const data = (ok ? a.usage : a.lastGoodUsage) ?? {};
    const windows = [];
    for (const [key,name] of WINDOWS) {
      const w = data?.[key], pct = w?.pct;
      if (!w || typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
      windows.push({ name, remaining: Math.round((100-pct)*10000)/10000, resetsAt: w.resetsAt });
    }
    return { id, legacyId: counts.get(identity)===1 ? legacyId : null, label:`${mask(a.email)} [${id.slice(0,6)}]`,
      readAt, fresh: ok && age !== null && age >= -300000 && age <= STALE_MS && windows.length>0, windows };
  });
}
export async function evaluateQuota(accounts, state, send) {
  const states = state.accounts ??= {};
  if (!accounts.length) {
    state.empty_count = (state.empty_count||0)+1;
    if (state.empty_count>=2 && !state.unavailable) { await send('[Claude 额度提醒] 连续两次无法读取 cswap 账号额度，请检查登录或额度查询。'); state.unavailable = true; }
    return;
  }
  state.empty_count=0;
  if (state.unavailable) { await send('[Claude 额度恢复] cswap 已重新返回账号额度；请查看状态中的更新时间。'); state.unavailable=false; }
  for (const a of accounts) {
    if (!states[a.id] && a.legacyId && states[a.legacyId]) states[a.id]=structuredClone(states[a.legacyId]);
    const entry=states[a.id] ??= { windows: {} }; entry.windows ??= {};
    if (!a.fresh) {
      entry.stale_count=(entry.stale_count||0)+1;
      if (entry.stale_count>=2 && !entry.stale_alerted) { await send(`[Claude 额度提醒] ${a.label} 的额度数据已过期或不可用，上次更新 ${timeLabel(a.readAt)}。`); entry.stale_alerted=true; }
      continue;
    }
    entry.stale_count=0;
    if (entry.stale_alerted) { await send(`[Claude 额度恢复] ${a.label} 的额度数据已刷新，更新于 ${timeLabel(a.readAt)}。`); entry.stale_alerted=false; }
    const present=new Set(a.windows.map(w=>w.name)), missing=['5 hours','7 days'].filter(n=>!present.has(n));
    entry.missing_count=missing.length ? (entry.missing_count||0)+1 : 0;
    if (entry.missing_count>=2 && !entry.missing_alerted) { await send(`[Claude 额度提醒] ${a.label} 的${missing.map(windowLabel).join('、')}额度连续两次不可用，请检查 cswap。`); entry.missing_alerted=true; }
    else if (!missing.length && entry.missing_alerted) { await send(`[Claude 额度恢复] ${a.label} 的五小时和每周额度已可读取。`); entry.missing_alerted=false; }
    for (const w of a.windows) {
      const previous=entry.windows[w.name] ?? {}, oldReset=parse(previous.reset), newReset=parse(w.resetsAt), observed=parse(a.readAt);
      let alerted=Boolean(previous.alerted);
      if (oldReset !== null && newReset !== null && observed !== null && newReset > oldReset+600000 && observed >= oldReset-300000) alerted=false;
      if (w.remaining<=20 && !alerted) { await send(`[Claude 额度提醒] ${a.label} ${windowLabel(w.name)}剩余 ${w.remaining}%，重置 ${timeLabel(w.resetsAt)}；数据更新 ${timeLabel(a.readAt)}。`); alerted=true; }
      else if (w.remaining>=25 && previous.alerted) { await send(`[Claude 额度恢复] ${a.label} ${windowLabel(w.name)}剩余 ${w.remaining}%，重置 ${timeLabel(w.resetsAt)}；数据更新 ${timeLabel(a.readAt)}。`); alerted=false; }
      entry.windows[w.name]={ alerted, reset:w.resetsAt };
    }
  }
}
const readText = async path => {try{return await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}};
async function readJson(path) {const s=await readText(path);if(s===null)return null;return JSON.parse(s);}
async function persist(path,value) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=`${path}.${process.pid}.tmp`;let file;
  try {file=await open(temp,'w',0o600);await file.writeFile(JSON.stringify(value));await file.sync();await file.close();file=null;await chmod(temp,0o600);await rename(temp,path);}
  finally {await file?.close().catch(()=>{});}
}
function freshCache(accounts, now) {
  if (!Array.isArray(accounts) || !accounts.length || accounts.some(a=>!a || typeof a!=='object' || !Array.isArray(a.windows))) return [];
  return accounts.map(a=>{const t=parse(a.readAt),age=t===null?null:now-t;return {...a,fresh:Boolean(a.fresh)&&age!==null&&age>=-300000&&age<=STALE_MS};});
}
export function nextQuotaDelay(lastCheckedAt, now = Date.now()) {
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return 5000;
  return Math.max(5000,Math.min(INTERVAL_MS,lastCheckedAt+INTERVAL_MS-now));
}
export async function startQuotaMonitor({ usageReader, send, stateDir=join(homedir(),'.local/state/feishu-terminal'),
  legacyDir=join(homedir(),'.local/state/magpie-quota-alert'), onError=()=>{}, onHealthy=()=>{}, now=Date.now, initialDelayMs }={}) {
  if (platform() !== 'linux') return { stop:async()=>{} };
  if (typeof usageReader?.raw!=='function' || typeof send!=='function') throw new TypeError('quota dependencies missing');
  const statePath=join(stateDir,'quota-alert.json'), cachePath=join(stateDir,'quota-cache.json');
  let state, sourcePath=statePath;
  try { state=await readJson(statePath);if(state===null){sourcePath=join(legacyDir,'state.json');state=await readJson(sourcePath)??{};}if(!state || Array.isArray(state) || typeof state!=='object')throw new Error(); }
  catch { throw new Error('quota state unreadable'); }
  let lastCheckedAt=state.last_checked_at;
  if (!Number.isFinite(lastCheckedAt)) { try { lastCheckedAt=(await stat(sourcePath)).mtimeMs; } catch (e) { if(e.code!=='ENOENT')throw e; } }
  let stopped=false, inFlight=null;
  const check=async()=>{
    if(stopped || inFlight)return inFlight;
    inFlight=(async()=>{
      let accounts=null;
      try { accounts=normalizeQuota(await usageReader.raw({timeoutMs:75000}),now());await persist(cachePath,accounts); }
      catch { try { accounts=freshCache((await readJson(cachePath))??(await readJson(join(legacyDir,'cache.json'))),now()); } catch { accounts=[]; } }
      try { await evaluateQuota(accounts??[],state,send); }
      finally { state.last_checked_at=now(); await persist(statePath,state); }
      onHealthy();
    })();
    try{await inFlight;}catch{onError('quota_monitor_failed');}finally{inFlight=null;}
  };
  let timer;
  const initial=setTimeout(()=>{
    check().catch(()=>onError('quota_monitor_failed'));
    timer=setInterval(()=>{check().catch(()=>onError('quota_monitor_failed'));},INTERVAL_MS);timer.unref();
  },initialDelayMs ?? nextQuotaDelay(lastCheckedAt,now()));initial.unref();
  return { stop:async()=>{stopped=true;clearTimeout(initial);if(timer)clearInterval(timer);await inFlight?.catch(()=>{});} };
}
