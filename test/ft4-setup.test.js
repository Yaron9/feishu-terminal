import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, NEEDED_SCOPES } from '../src/setup.js';

async function fixture(t, openId = 'ou_owner') {
  const dir = await mkdtemp(new URL('../.test-ft4-setup-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { configFile: join(dir, 'config.json'), envFile: join(dir, '.env'), stateDir: join(dir, 'state') };
  const calls = [], errors = []; let registrations = 0;
  const options = { paths, stdout() {}, stderr: s => errors.push(s),
    registerApp: async () => {
      registrations++;
      return { client_id: `cli_app${registrations}`, client_secret: 'private_secret', user_info: { open_id: openId } };
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
      let response;
      if (url.endsWith('/internal')) response = { tenant_access_token: 'private_token' };
      else if (url.endsWith('/members/is_in_chat')) response = { data: { is_in_chat: true } };
      else if (url.includes('/chats?') && init.method === 'GET') response = { data: { items: [], has_more: false } };
      else if (url.includes('/chats?')) response = { data: { chat_id: 'oc_created' } };
      else if (url.includes('/messages?')) response = { data: { message_id: 'om_welcome' } };
      else if (url.endsWith('/scopes')) response = { data: { scopes: NEEDED_SCOPES.map(scope_name => ({ scope_name, grant_status: 1 })) } };
      else throw new Error('unexpected request');
      return { ok: true, status: 200, json: async () => ({ code: 0, ...response }) };
    },
  };
  return { paths, calls, errors, options, get registrations() { return registrations; },
    run: overrides => setup({ ...options, ...overrides }),
    progress: async () => JSON.parse(await readFile(join(paths.stateDir, 'setup-progress.json'), 'utf8')) };
}

test('missing or invalid registration operator saves credentials privately and resumes the same app with --operator', async t => {
  for (const openId of [undefined, 'invalid']) {
    const f = await fixture(t, openId);
    // Explicit undefined must not activate the fixture default.
    if (openId === undefined) f.options.registerApp = async () => ({ client_id: 'cli_app1', client_secret: 'private_secret', user_info: {} });
    assert.equal(await f.run(), 3);
    assert.match(f.errors.join('\n'), /missing_operator/);
    assert.match(await readFile(f.paths.envFile, 'utf8'), /FEISHU_APP_SECRET=private_secret/);
    const progress = await f.progress();
    assert.deepEqual(progress.registered, { app_id: 'cli_app1' });
    assert.ok(!JSON.stringify(progress).includes('private_secret'));
    if (process.platform !== 'win32') assert.equal((await stat(join(f.paths.stateDir, 'setup-progress.json'))).mode & 0o777, 0o600);
    assert.equal(f.calls.length, 0);
    const registrations = f.registrations;
    assert.equal(await f.run({ operator: 'ou_resumed' }), 0);
    assert.equal(f.registrations, registrations);
    const config = JSON.parse(await readFile(f.paths.configFile, 'utf8'));
    assert.deepEqual(config.operatorOpenIds, ['ou_resumed']);
    assert.equal(f.calls.find(c => c.url.includes('/chats?') && c.method === 'POST').body.owner_id, 'ou_resumed');
  }
});
