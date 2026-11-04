import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { runtimePaths } from './runtime.js';

export async function loadConfig(env = process.env) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Set FEISHU_APP_ID and FEISHU_APP_SECRET on the runtime machine');
  const filename = runtimePaths(env).configFile;
  const config = JSON.parse(await readFile(filename, 'utf8'));
  if (!Array.isArray(config.chatIds) || !config.chatIds.length || !config.chatIds.every(id => /^oc_[A-Za-z0-9]+$/.test(id))) throw new Error('Configure allowed Feishu groups in chatIds');
  if (!Array.isArray(config.operatorOpenIds) || !config.operatorOpenIds.length || !config.operatorOpenIds.every(id => /^ou_[A-Za-z0-9]+$/.test(id))) throw new Error('Configure operatorOpenIds');
  if (typeof config.defaultCwd !== 'string' || !isAbsolute(config.defaultCwd)) throw new Error('defaultCwd must be an absolute path');
  if (!await stat(config.defaultCwd).then(info => info.isDirectory(), () => false)) throw new Error('defaultCwd must be an existing directory');
  if (config.groups !== undefined) {
    if (!config.groups || typeof config.groups !== 'object' || Array.isArray(config.groups)) throw new Error('Invalid groups configuration');
    for (const [chatId, group] of Object.entries(config.groups)) {
      if (!/^oc_[A-Za-z0-9]+$/.test(chatId) || !group || typeof group !== 'object' || Array.isArray(group)) throw new Error('Invalid group');
      if (group.operatorOpenIds !== undefined && (!Array.isArray(group.operatorOpenIds) ||
          !group.operatorOpenIds.every(id => /^ou_[A-Za-z0-9]+$/.test(id)))) throw new Error('Invalid group operatorOpenIds');
      if (group.cwd !== undefined && (typeof group.cwd !== 'string' || !isAbsolute(group.cwd) ||
          !await stat(group.cwd).then(info => info.isDirectory(), () => false))) throw new Error('group cwd must be an existing absolute directory');
      for (const key of ['project', 'machine']) if (group[key] !== undefined && typeof group[key] !== 'string') throw new Error('Invalid group metadata');
    }
  }
  // Credentials are never read from JSON, nor returned as part of the config.
  if ('appId' in config || 'appSecret' in config || 'FEISHU_APP_SECRET' in config) throw new Error('Credentials belong only in env/.env');
  const backends = config.backends ?? ['hc', 'herdr'];
  const newTerminalBackend = config.newTerminalBackend ?? 'hc', sessionFollow = config.sessionFollow ?? 'newest';
  if (!Array.isArray(backends) || !backends.length || new Set(backends).size !== backends.length ||
      !backends.every(b => ['hc', 'herdr'].includes(b)) || !backends.includes(newTerminalBackend) ||
      !['newest', 'warn'].includes(sessionFollow)) throw new Error('Invalid backend/sessionFollow configuration');
  return { chatIds: config.chatIds, operatorOpenIds: config.operatorOpenIds, defaultCwd: config.defaultCwd,
    ...(config.groups === undefined ? {} : { groups: config.groups }),
    backends, newTerminalBackend, sessionFollow,
    stateFile: resolve(dirname(filename), config.stateFile || join(homedir(), '.local/state/feishu-terminal/bridge.json')),
    auditFile: resolve(dirname(filename), config.auditFile || join(homedir(), '.local/state/feishu-terminal/audit.jsonl')) };
}
