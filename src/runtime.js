import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function runtimePaths(env = process.env, cwd = process.cwd()) {
  const configFile = resolve(cwd, env.FEISHU_TERMINAL_CONFIG || join(homedir(), '.config/feishu-terminal/config.json'));
  return { configFile, envFile: join(dirname(configFile), '.env'),
    stateDir: resolve(env.STATE || join(homedir(), '.local/state/feishu-terminal')) };
}

export function prepareEnvironment() {
  const paths = runtimePaths();
  // Node's dotenv loader preserves variables already supplied by the caller.
  if (existsSync(paths.envFile)) process.loadEnvFile(paths.envFile);
  process.env.FEISHU_TERMINAL_CONFIG = paths.configFile;
  return runtimePaths();
}
