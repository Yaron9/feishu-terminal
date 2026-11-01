import { open, link, readFile, unlink, lstat, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function processStart(pid) {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() + ':' + stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  }
  const { stdout } = process.platform === 'win32'
    ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`], { windowsHide: true })
    : await exec('ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (!stdout.trim()) throw new Error('Process identity unavailable');
  return stdout.trim();
}
let ownStart;
const selfStart = () => ownStart ??= processStart(process.pid);
async function alive(owner) {
  try { process.kill(owner.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
  if (!owner.startTime) return true; // legacy numeric lock: never steal a live PID
  try { return owner.startTime === await (owner.pid === process.pid ? selfStart() : processStart(owner.pid)); }
  catch { return true; } // inability to confirm death is not permission to steal
}
async function readOwner(file, recovery = false) {
  const stat = await lstat(file);
  let text;
  if (stat.isDirectory() && recovery) {
    try { text = await readFile(join(file, 'owner.json'), 'utf8'); }
    catch (error) {
      // Old versions could die between mkdir and writing identity. After a
      // grace period, bypass that immutable empty directory, never delete a
      // possibly live new guard to make room.
      if (error.code !== 'ENOENT') throw error;
      if (Date.now() - stat.mtimeMs < 30000) throw new Error('Another instance is recovering the state file');
      return { abandoned: true, token: `legacy:${stat.mtimeMs}` };
    }
  } else text = await readFile(file, 'utf8');
  let owner;
  try { owner = JSON.parse(text); } catch { throw new Error('Invalid instance lock; inspect manually'); }
  if (Number.isSafeInteger(owner) && owner > 0) return { pid: owner };
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.startTime !== 'string' || !owner.startTime)
    throw new Error('Invalid instance lock; inspect manually');
  return owner;
}
// Publish a complete owner record atomically: a kill cannot leave an empty
// lock/guard. Hard-link admission is exclusive on Windows and POSIX.
async function publish(file, owner) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    await link(temp, file);
    return () => unlink(file);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function recoveryGuard(file, owner) {
  const root = file + '.recovery', stale = [];
  let path = root;
  for (;;) {
    try { return { release: await publish(path, owner), stale }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let previous;
    try { previous = await readOwner(path, true); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!previous.abandoned && await alive(previous)) throw new Error('Another instance is recovering the state file');
    stale.push(path);
    // All contenders follow the same dead holder to the same successor. Never
    // unlink a shared guard to reclaim it: that races a new live holder.
    path = root + '.' + createHash('sha256').update(JSON.stringify(previous)).digest('hex').slice(0, 32);
  }
}
async function removeStale(path) {
  if ((await lstat(path)).isDirectory()) {
    await unlink(join(path, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(path);
  } else await unlink(path);
}

export async function acquireLock(file) {
  const owner = { pid: process.pid, startTime: await selfStart(), token: randomUUID() };
  try { return await publish(file, owner); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const guard = await recoveryGuard(file, owner);
  try {
    let previous;
    try { previous = await readOwner(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      if (await alive(previous)) throw new Error('Another instance owns the state file');
      await unlink(file);
    }
    const release = await publish(file, owner);
    // Only prune dead ancestors once the new main lock is visible and live.
    for (const path of guard.stale) await removeStale(path).catch(() => {});
    return release;
  } finally { await guard.release(); }
}
