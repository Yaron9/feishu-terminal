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

test('missing open_id creates a bot-only group and claims only the first human, durably before acknowledgement', async t => {
  const f = await fixture(t), fetchImpl = f.options.fetchImpl;
  let polls = 0, acknowledged = false;
  const run = { registerApp: async () => ({ client_id: 'cli_fixture', client_secret: 'private_secret', user_info: {} }),
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      if (url.endsWith('/link')) {
        assert.equal(init.method, 'POST');
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { share_link: 'https://applink.feishu.cn/join-fixture' } }) };
      }
      if (url.includes('/messages?container_id_type=chat')) {
        polls++;
        assert.ok(url.includes('container_id=oc_created') && url.includes('ByCreateTimeAsc'));
        const items = [{ sender: { sender_type: 'app', id_type: 'open_id', id: 'ou_bot' } }];
        if (polls > 1) items.push(...['ou_first', 'ou_second'].map(id => ({ sender: { sender_type: 'user', id_type: 'open_id', id } })));
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { items, has_more: false } }) };
      }
      if (url.includes('/messages?receive_id_type') && JSON.parse(init.body).content.includes('第一位')) {
        assert.equal(JSON.parse(await readFile(join(f.paths.stateDir, 'setup-progress.json'), 'utf8')).operator_open_id, 'ou_first');
        acknowledged = true;
      }
      return fetchImpl(url, init);
    } };
  assert.equal(await f.run(run), 0, f.err.join('\n'));
  assert.deepEqual((await f.config()).operatorOpenIds, ['ou_first']);
  const group = f.calls.find(c => c.url.includes('/chats?') && c.method === 'POST').body;
  assert.equal(group.owner_id, undefined); assert.equal(group.user_id_list, undefined);
  assert.ok(f.out.includes('SETUP_JOIN_URL https://applink.feishu.cn/join-fixture'));
  assert.equal(acknowledged, true); assert.equal(polls, 2);
});

test('claim expires within fifteen minutes, preserves the app and group, and --operator resumes them', async t => {
  const f = await fixture(t), fetchImpl = f.options.fetchImpl;
  let time = 1_000_000;
  const options = { registerApp: async () => ({ client_id: 'cli_fixture', client_secret: 'private_secret' }),
    now: () => time, sleep: async ms => { time += ms; },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/link')) return { ok: true, json: async () => ({ code: 0, data: { share_link: 'https://applink.feishu.cn/join-fixture' } }) };
      if (url.includes('/messages?container_id_type=chat')) return { ok: true, json: async () => ({ code: 0, data: { items: [], has_more: false } }) };
      return fetchImpl(url, init);
    } };
  assert.equal(await f.run(options), 3, f.err.join('\n'));
  assert.equal(time, 1_900_000);
  assert.match(f.err.join('\n'), /claim_expired/);
  const before = JSON.parse(await readFile(join(f.paths.stateDir, 'setup-progress.json'), 'utf8'));
  assert.equal(before.group_created.chat_id, 'oc_created');
  const polls = f.out.length;
  assert.equal(await f.run(options), 3); // Resume cannot restart the claim clock.
  assert.equal(time, 1_900_000); assert.equal(f.out.length, polls);
  assert.equal(await f.run({ operator: 'ou_explicit' }), 0);
  assert.equal(f.calls.filter(c => c.url.includes('/chats?') && c.method === 'POST').length, 1);
  assert.deepEqual((await f.config()).operatorOpenIds, ['ou_explicit']);
});

test('claim saves the first operator across a lost acknowledgement and retries with the same UUID', async t => {
  const f = await fixture(t), fetchImpl = f.options.fetchImpl;
  let uuid;
  assert.equal(await f.run({ registerApp: async () => ({ client_id: 'cli_fixture', client_secret: 'private_secret' }),
    fetchImpl: async (url, init) => {
      if (url.endsWith('/link')) return { ok: true, json: async () => ({ code: 0, data: { share_link: 'https://applink.feishu.cn/join-fixture' } }) };
      if (url.includes('/messages?container_id_type=chat')) return { ok: true, json: async () => ({ code: 0, data: {
        items: [{ sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_claimed' } }], has_more: false } }) };
      if (url.includes('/messages?receive_id_type')) { uuid = JSON.parse(init.body).uuid; throw new Error('response lost'); }
      return fetchImpl(url, init);
    } }), 1);
  assert.equal(await f.run(), 0, f.err.join('\n'));
  assert.equal(f.calls.find(c => c.url.includes('/messages?')).body.uuid, uuid);
  assert.deepEqual((await f.config()).operatorOpenIds, ['ou_claimed']);
  assert.equal(f.calls.filter(c => c.url.includes('/chats?') && c.method === 'POST').length, 1);
});
