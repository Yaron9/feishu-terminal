import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';

export async function loadConfig(env = process.env) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Set FEISHU_APP_ID and FEISHU_APP_SECRET on the runtime machine');
  const filename = resolve(env.FEISHU_TERMINAL_CONFIG || 'config.json');
  const config = JSON.parse(await readFile(filename, 'utf8'));
  if (!Array.isArray(config.chatIds) || config.chatIds.length !== 1 || !config.chatIds.every(id => /^oc_[A-Za-z0-9]+$/.test(id))) throw new Error('Configure exactly one allowed Feishu group in chatIds');
  if (!Array.isArray(config.operatorOpenIds) || !config.operatorOpenIds.length || !config.operatorOpenIds.every(id => /^ou_[A-Za-z0-9]+$/.test(id))) throw new Error('Configure operatorOpenIds');
  if (typeof config.defaultCwd !== 'string' || !isAbsolute(config.defaultCwd)) throw new Error('defaultCwd must be an absolute path');
  if (!await stat(config.defaultCwd).then(info => info.isDirectory(), () => false)) throw new Error('defaultCwd must be an existing directory');
  // Credentials are never read from JSON, nor returned as part of the config.
  if ('appId' in config || 'appSecret' in config || 'FEISHU_APP_SECRET' in config) throw new Error('Credentials belong only in env/.env');
  return { chatIds: config.chatIds, operatorOpenIds: config.operatorOpenIds, defaultCwd: config.defaultCwd,
    stateFile: resolve(config.stateFile || join(homedir(), '.local/state/feishu-terminal/bridge.json')),
    auditFile: resolve(config.auditFile || join(homedir(), '.local/state/feishu-terminal/audit.jsonl')) };
}
