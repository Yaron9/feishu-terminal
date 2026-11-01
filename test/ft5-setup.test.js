import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setup, NEEDED_SCOPES, WELCOME } from '../src/setup.js';

async function fixture(t) {
  const dir = await mkdtemp(new URL('../.test-ft5-setup-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { configFile: join(dir, 'config.json'), envFile: join(dir, '.env'), stateDir: join(dir, 'state') };
  const out = [], err = [], calls = []; let registration;
  const options = { paths, stdout: s => out.push(s), stderr: s => err.push(s),
    registerApp: async opts => {
      registration = opts;
      return { client_id: 'cli_fixture', client_secret: 'private_secret', user_info: { open_id: 'ou_owner' } };
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
      let data;
      if (url.endsWith('/internal')) return { ok: true, status: 200, json: async () => ({ tenant_access_token: 'private_token' }) };
      if (url.endsWith('/members/is_in_chat')) data = { is_in_chat: true };
      else if (url.includes('/chats?') && init.method === 'GET') data = { items: [], has_more: false };
      else if (url.includes('/chats?')) data = { chat_id: 'oc_created' };
      else if (url.includes('/messages?')) data = { message_id: 'om_welcome' };
      else if (url.endsWith('/scopes')) data = { scopes: NEEDED_SCOPES.map(scope_name => ({ scope_name, grant_status: 1 })) };
      else throw new Error('unexpected request');
      return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
    } };
  return { paths, out, err, calls, options, get registration() { return registration; },
    run: overrides => setup({ ...options, ...overrides }),
    config: async () => JSON.parse(await readFile(paths.configFile, 'utf8')) };
}

test('setup replaces example cwd and state placeholders, including an already configured app', async t => {
  const f = await fixture(t);
  assert.equal(await f.run(), 0);
  const config = await f.config();
  Object.assign(config, { defaultCwd: '/home/REPLACE_WITH_USER', stateFile: './state/bridge.json', auditFile: './state/audit.jsonl' });
  await writeFile(f.paths.configFile, JSON.stringify(config));
  assert.equal(await f.run(), 0);
  assert.deepEqual(await f.config(), { ...config, defaultCwd: homedir(),
    stateFile: join(f.paths.stateDir, 'bridge.json'), auditFile: join(f.paths.stateDir, 'audit.jsonl') });
});

test('setup preserves custom cwd and state paths', async t => {
  const f = await fixture(t);
  const custom = { defaultCwd: homedir(), stateFile: join(f.paths.stateDir, 'custom.json'), auditFile: join(f.paths.stateDir, 'custom.log') };
  await writeFile(f.paths.configFile, JSON.stringify(custom));
  assert.equal(await f.run(), 0);
  for (const [key, value] of Object.entries(custom)) assert.equal((await f.config())[key], value);
});

test('setup prints the absolute selected config path to stderr only', async t => {
  const f = await fixture(t);
  assert.equal(await f.run(), 0);
  assert.ok(f.err.includes(`CONFIG ${f.paths.configFile}`));
  assert.ok(!f.out.some(line => line.includes(f.paths.configFile)));
});

test('welcome requires every top-level and in-topic message to mention the bot until approval', () => {
  assert.match(WELCOME, /全群消息权限审批完成前/);
  assert.match(WELCOME, /每条消息（包括新话题和话题内回复）都必须 @机器人/);
});

test('setup requires chat readonly and reports only numeric platform code and HTTP status on stage failure', async t => {
  const f = await fixture(t);
  const fetchImpl = f.options.fetchImpl;
  assert.equal(await f.run({ fetchImpl: async (url, init) => url.includes('/chats?') ? {
    ok: false, status: 403, json: async () => ({ code: 99991672, msg: 'private_secret private_token device_code', data: { private: 'payload' } }),
  } : fetchImpl(url, init) }), 1);
  assert.match(f.err.join('\n'), /group_lookup\/api_failed.*http_status=403.*feishu_code=99991672/);
  assert.doesNotMatch(f.err.join('\n'), /private_secret|private_token|device_code|payload/);
  assert.deepEqual(f.registration.addons.scopes.tenant, ['im:message.group_msg', 'im:chat:readonly']);
  f.err.length = 0;
  assert.equal(await f.run({ fetchImpl: async (url, init) => url.endsWith('/scopes') ? {
    ok: true, status: 200, json: async () => ({ code: 0, data: { scopes: NEEDED_SCOPES.filter(s => s !== 'im:chat:readonly').map(scope_name => ({ scope_name, grant_status: 1 })) } }),
  } : fetchImpl(url, init) }), 1);
  assert.match(f.err.join('\n'), /required_scopes_missing/);
});
