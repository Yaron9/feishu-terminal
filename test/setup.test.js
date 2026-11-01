import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { registerApp as sdkRegisterApp, defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { setup, setupApi, NEEDED_SCOPES, saveCredentials } from '../src/setup.js';

async function fixture(t, { outcome, existing = false, pending = false, newGroup = false } = {}) {
  const dir = await mkdtemp(new URL('../.test-setup-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { configFile: join(dir, 'config.json'), envFile: join(dir, '.env'), stateDir: join(dir, 'state') };
  const original = '# keep me\r\nOTHER=value\r\nFEISHU_APP_ID=old\r\nFEISHU_APP_SECRET=oldsecret\r\nHERDR_SOCKET_PATH=/isolated.sock\r\n';
  await writeFile(paths.envFile, original);
  const config = { chatIds: [existing ? 'oc_existing' : 'oc_REPLACE_WITH_ONE_GROUP_ID'], operatorOpenIds: ['ou_old'],
    defaultCwd: '/tmp', custom: 'preserved' };
  await writeFile(paths.configFile, JSON.stringify(config));
  const out = [], err = [], calls = []; let options;
  const registerApp = async opts => {
    options = opts;
    opts.onQRCodeReady({ url: 'https://open.feishu.cn/page/launcher?user_code=test', expireIn: 600 });
    if (outcome === 'slow_down') opts.onStatusChange({ status: 'slow_down', interval: 10 });
    if (['access_denied', 'expired_token', 'other'].includes(outcome)) throw Object.assign(new Error('secret device_code sensitive'), { code: outcome });
    return { client_id: 'cli_fixture', client_secret: 'secret_fixture', user_info: { open_id: 'ou_fixture', tenant_brand: 'feishu' } };
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    let response;
    if (url.endsWith('/internal')) response = { tenant_access_token: 'tenant_fixture' };
    else if (url.endsWith('/members/is_in_chat')) response = { data: { is_in_chat: true } };
    else if (url.includes('/chats?') && init.method === 'GET') response = { data: { items: [], has_more: false } };
    else if (url.includes('/chats?')) response = { data: { chat_id: 'oc_created' } };
    else if (url.includes('/messages?')) response = { data: { message_id: 'om_welcome' } };
    else if (url.endsWith('/scopes')) response = { data: { scopes: NEEDED_SCOPES.map(scope_name => ({ scope_name, grant_status: pending && scope_name === 'im:message.group_msg' ? 2 : 1 })) } };
    else throw new Error('unexpected HTTP');
    return { ok: true, status: 200, json: async () => ({ code: 0, ...response }) };
  };
  const code = await setup({ paths, registerApp, fetchImpl, stdout: s => out.push(s), stderr: s => err.push(s), newGroup, newApp: true });
  return { dir, paths, original, config, out, err, calls, options, code };
}

test('setup registers with exact pinned SDK options, creates owner topic group, writes private merged config and welcomes', async t => {
  const f = await fixture(t);
  assert.equal(f.code, 0);
  assert.equal(f.options.createOnly, true);
  assert.deepEqual(f.options.appPreset, { name: 'VPS 终端', desc: '飞书话题 ↔ VPS herdr 终端' });
  assert.deepEqual(f.options.addons, { preset: true, scopes: { tenant: ['im:message.group_msg', 'im:chat:readonly'] } });
  assert.match(f.out[0], /^SETUP_URL https:\/\/open.feishu.cn\//);
  assert.match(f.out[1], /^SETUP_EXPIRES \d{4}-/); assert.equal(f.out.length, 2);
  assert.equal(await readFile(join(f.paths.stateDir, 'setup-url.txt'), 'utf8'), f.out.join('\n') + '\n');
  const env = await readFile(f.paths.envFile, 'utf8');
  assert.equal(env, f.original.replace('FEISHU_APP_ID=old', 'FEISHU_APP_ID=cli_fixture').replace('FEISHU_APP_SECRET=oldsecret', 'FEISHU_APP_SECRET=secret_fixture'));
  const backups = (await readdir(f.dir)).filter(n => n.startsWith('.env.bak-'));
  assert.equal(backups.length, 1); assert.equal(await readFile(join(f.dir, backups[0]), 'utf8'), f.original);
  const config = JSON.parse(await readFile(f.paths.configFile, 'utf8'));
  assert.deepEqual(config.chatIds, ['oc_created']); assert.deepEqual(config.operatorOpenIds, ['ou_fixture']);
  assert.equal(config.custom, 'preserved'); assert.equal(config.defaultCwd, '/tmp');
  const group = f.calls.find(c => c.url.includes('/chats?') && c.method === 'POST');
  assert.equal(group.url, 'https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id');
  assert.equal(group.body.group_message_type, 'thread'); assert.equal(group.body.owner_id, 'ou_fixture');
  assert.deepEqual(group.body.user_id_list, ['ou_fixture']); assert.equal(group.headers.Authorization, 'Bearer tenant_fixture');
  const welcome = JSON.parse(f.calls.find(c => c.url.includes('/messages?')).body.content).text;
  for (const command of ['/t ls', '/t open', '/t screen', '/t k', '/t raw', '/t close', 'Refresh']) assert.ok(welcome.includes(command));
  assert.ok(f.err.includes('SETUP OK'));
  assert.ok(![...f.out, ...f.err].join('\n').match(/secret_fixture|tenant_fixture|device_code/));
  for (const file of [f.paths.envFile, f.paths.configFile, join(f.paths.stateDir, 'setup-url.txt'), join(f.dir, backups[0])]) {
    const mode = (await stat(file)).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
  }
  assert.ok(!(await readdir(f.dir)).some(n => n.endsWith('.tmp') || n.endsWith('.lock')));
});

for (const outcome of ['access_denied', 'expired_token', 'other']) test(`setup ${outcome}: correct exit, no credentials or HTTP side effects`, async t => {
  const f = await fixture(t, { outcome });
  assert.equal(f.code, outcome === 'other' ? 1 : 2);
  assert.equal(f.calls.length, 0); assert.equal(await readFile(f.paths.envFile, 'utf8'), f.original);
  assert.deepEqual(JSON.parse(await readFile(f.paths.configFile, 'utf8')), f.config);
  assert.ok(!f.err.join('\n').includes('sensitive'));
});

test('setup slow_down continues via the SDK and pending group_msg explicitly permits @mention fallback', async t => {
  const f = await fixture(t, { outcome: 'slow_down', pending: true });
  assert.equal(f.code, 0); assert.match(f.err.join('\n'), /slow_down/); assert.match(f.err.join('\n'), /@机器人/);
  assert.match(f.err.join('\n'), /im:message.group_msg\tnot granted/);
});

test('existing real chat skips creation; --new-group overrides it', async t => {
  const keep = await fixture(t, { existing: true });
  assert.equal(keep.code, 0); assert.ok(!keep.calls.some(c => c.url.includes('/chats?') && c.method === 'POST'));
  assert.ok(keep.calls.some(c => c.url.endsWith('/oc_existing/members/is_in_chat') && c.headers.Authorization === 'Bearer tenant_fixture'));
  assert.equal(JSON.parse(await readFile(keep.paths.configFile, 'utf8')).chatIds[0], 'oc_existing');
  const fresh = await fixture(t, { existing: true, newGroup: true });
  assert.equal(fresh.code, 0); assert.ok(fresh.calls.some(c => c.url.includes('/chats?') && c.method === 'POST'));
});

test('dotenv merge replaces exported/duplicate credentials, preserves unrelated lines and refuses multiline injection', async t => {
  const dir = await mkdtemp(new URL('../.test-env-', import.meta.url)); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  await writeFile(file, '# env\nexport FEISHU_APP_ID=old\nFEISHU_APP_ID=duplicate\nX=stay\n');
  await saveCredentials(file, 'cli_new', 'new_secret');
  assert.equal(await readFile(file, 'utf8'), '# env\nFEISHU_APP_ID=cli_new\nX=stay\nFEISHU_APP_SECRET=new_secret\n');
  await assert.rejects(saveCredentials(file, 'cli_new', 'secret\nINJECT=1'));
});

test('HTTP throttling honors slow retry; ambiguous network writes and upstream errors are sanitized', async () => {
  let calls = 0; const waits = [];
  const api = setupApi({ sleep: async ms => waits.push(ms), fetchImpl: async () => ++calls === 1
    ? { status: 429, ok: false, headers: { get: () => '3' }, json: async () => ({ code: 99991400 }) }
    : { status: 200, ok: true, json: async () => ({ code: 0, data: {} }) } });
  await api('/test'); assert.equal(calls, 2); assert.deepEqual(waits, [3000]);
  calls = 0;
  const broken = setupApi({ fetchImpl: async () => { calls++; throw new Error('secret token device_code'); } });
  await assert.rejects(broken('/test', { method: 'POST', body: {} }), { message: 'network_error' }); assert.equal(calls, 1);
});

test('actual 1.76.0 registerApp encodes addons and handles HTTP device-flow slow_down, denial and expiry without network', async t => {
  const original = defaultHttpInstance.post;
  t.after(() => { defaultHttpInstance.post = original; });
  let opts, polls = 0; const statuses = [];
  defaultHttpInstance.post = async (_url, body) => {
    const action = new URLSearchParams(body).get('action');
    if (action === 'begin') return { verification_uri_complete: 'https://open.feishu.cn/page/launcher?user_code=mock', device_code: 'private', interval: 0, expires_in: 60 };
    polls++;
    return { error: 'slow_down' };
  };
  const abort = new AbortController();
  await assert.rejects(sdkRegisterApp({ createOnly: true, addons: { preset: true, scopes: { tenant: ['im:message.group_msg'] } },
    signal: abort.signal, onQRCodeReady: info => { opts = info; }, onStatusChange: status => { statuses.push(status); abort.abort(); } }), e => e.code === 'abort');
  const { gunzipSync } = await import('node:zlib');
  const url = new URL(opts.url);
  assert.equal(url.searchParams.get('createOnly'), 'true');
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(url.searchParams.get('addons'), 'base64url'))), { preset: true, scopes: { tenant: ['im:message.group_msg'] } });
  assert.equal(polls, 1); assert.deepEqual(statuses, [{ status: 'slow_down', interval: 5 }]);
  for (const code of ['access_denied', 'expired_token']) {
    defaultHttpInstance.post = async (_url, body) => new URLSearchParams(body).get('action') === 'begin'
      ? { verification_uri_complete: 'https://open.feishu.cn/page/launcher', device_code: 'private', expires_in: 60 }
      : { error: code };
    await assert.rejects(sdkRegisterApp({ onQRCodeReady() {} }), e => e.code === code);
  }
  defaultHttpInstance.post = async (_url, body) => new URLSearchParams(body).get('action') === 'begin'
    ? { verification_uri_complete: 'https://open.feishu.cn/page/launcher', device_code: 'private', expires_in: 60 }
    : { client_id: 'cli_mock', client_secret: 'mock_secret', user_info: { open_id: 'ou_mock' } };
  assert.deepEqual(await sdkRegisterApp({ onQRCodeReady() {} }),
    { client_id: 'cli_mock', client_secret: 'mock_secret', user_info: { open_id: 'ou_mock' } });
  defaultHttpInstance.post = async (_url, body) => new URLSearchParams(body).get('action') === 'begin'
    ? { verification_uri_complete: 'https://open.feishu.cn/page/launcher', device_code: 'private', interval: 100, expires_in: 0.005 }
    : { error: 'authorization_pending' };
  await assert.rejects(sdkRegisterApp({ onQRCodeReady() {} }), e => e.code === 'expired_token');
});
