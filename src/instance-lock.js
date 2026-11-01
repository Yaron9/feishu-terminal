import { open, mkdir, readFile, unlink, rmdir } from 'node:fs/promises';

// Serialize stale-PID recovery. Never steal a live process's lock, including
// when its PID has been reused. No network listener or extra dependency.
export async function acquireLock(file) {
  const create = async () => {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(String(process.pid)); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(file); throw error; }
    return async () => { await handle.close(); await unlink(file); };
  };
  try { return await create(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const guard = file + '.recovery';
  await mkdir(guard, { mode: 0o700 });
  try {
    let pid;
    try { pid = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return await create(); throw error; }
    if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('Invalid instance lock; inspect manually');
    let alive = true;
    try { process.kill(Number(pid), 0); }
    catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('Another instance owns the state file');
    await unlink(file);
    return await create();
  } finally { await rmdir(guard); }
}
