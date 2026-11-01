import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
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
      else if (url.includes('/members?')) response = { data: { items: [{ member_id_type: 'open_id', member_id: 'ou_owner' }], has_more: false } };
      else if (/\/chats\/[^/?]+\?user_id_type=/.test(url)) response = { data: { group_message_type: 'thread' } };
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

test('invalid registration operator saves credentials privately and resumes the same app with --operator', async t => {
  for (const openId of ['invalid']) {
    const f = await fixture(t, openId);
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

for (const stage of ['registered', 'group_created', 'configured', 'welcomed', 'scopes_checked']) {
  test(`setup resumes the same app after failure following ${stage}`, async t => {
    const f = await fixture(t); const fetchImpl = f.options.fetchImpl; let injected = false;
    const fail = () => { injected = true; throw new Error('simulated interruption'); };
    const code = await f.run({
      fetchImpl: async (url, init) => {
        if (!injected && stage === 'registered' && url.includes('/chats?')) fail();
        if (!injected && stage === 'configured' && url.includes('/messages?')) fail();
        if (!injected && stage === 'welcomed' && url.endsWith('/scopes')) fail();
        const response = await fetchImpl(url, init);
        if (!injected && stage === 'group_created' && url.includes('/chats?') && init.method === 'POST') {
          injected = true; await mkdir(f.paths.configFile); // Fail the real atomic config write.
        }
        return response;
      },
      stderr: line => { if (!injected && stage === 'scopes_checked' && line === 'SETUP OK') fail(); },
    });
    assert.equal(code, 1); assert.equal(injected, true);
    assert.ok((await f.progress())[stage], `${stage} is durable before the next operation`);
    if (stage === 'group_created') await rm(f.paths.configFile, { recursive: true });
    const creates = f.calls.filter(c => c.url.includes('/chats?') && c.method === 'POST').length;
    const welcomes = f.calls.filter(c => c.url.includes('/messages?')).length;
    const scopes = f.calls.filter(c => c.url.endsWith('/scopes')).length;
    assert.equal(await f.run(), 0);
    assert.equal(f.registrations, 1);
    assert.equal(f.calls.filter(c => c.url.includes('/chats?') && c.method === 'POST').length, stage === 'registered' ? 1 : creates);
    if (['welcomed', 'scopes_checked'].includes(stage)) assert.equal(f.calls.filter(c => c.url.includes('/messages?')).length, welcomes);
    if (stage === 'scopes_checked') assert.equal(f.calls.filter(c => c.url.endsWith('/scopes')).length, scopes);
    const progress = await f.progress();
    assert.deepEqual(progress.registered, { app_id: 'cli_app1' });
    assert.deepEqual(progress.group_created, { chat_id: 'oc_created' });
    for (const done of ['configured', 'welcomed', 'scopes_checked']) assert.equal(progress[done], true);
    assert.ok(!JSON.stringify(progress).includes('private_secret'));
  });
}

for (const outcome of ['lost', 'missing_id']) test(`setup recovers a ${outcome} group-create response by paginated bot membership lookup`, async t => {
  const f = await fixture(t); const fetchImpl = f.options.fetchImpl; let groupExists = false;
  const fetchRecovery = async (url, init) => {
    if (url.includes('/chats?') && init.method === 'GET' && groupExists) {
      const secondPage = url.includes('page_token=next');
      return { ok: true, json: async () => ({ code: 0, data: secondPage
        ? { items: [{ chat_id: 'oc_recovered', name: 'VPS 终端' }], has_more: false }
        : { items: [{ chat_id: 'oc_other', name: 'Other' }], has_more: true, page_token: 'next' } }) };
    }
    const response = await fetchImpl(url, init);
    if (url.includes('/chats?') && init.method === 'POST') {
      groupExists = true;
      if (outcome === 'lost') throw new Error('response lost after server created group');
      return { ok: true, json: async () => ({ code: 0, data: {} }) };
    }
    return response;
  };
  assert.equal(await f.run({ fetchImpl: fetchRecovery }), 1);
  assert.equal(await f.run({ fetchImpl: fetchRecovery }), 0);
  assert.equal(f.registrations, 1);
  assert.equal(f.calls.filter(c => c.url.includes('/chats?') && c.method === 'POST').length, 1);
  assert.equal((await f.progress()).group_created.chat_id, 'oc_recovered');
});

test('setup verifies configured chat membership with the current bot token and replaces a foreign group', async t => {
  const f = await fixture(t);
  await writeFile(f.paths.configFile, JSON.stringify({ chatIds: ['oc_foreign'], operatorOpenIds: ['ou_old'] }));
  const fetchImpl = f.options.fetchImpl;
  assert.equal(await f.run({ fetchImpl: async (url, init) => {
    if (url.includes('/oc_foreign/members/is_in_chat')) {
      assert.equal(init.headers.Authorization, 'Bearer private_token');
      return { ok: true, json: async () => ({ code: 0, data: { is_in_chat: false } }) };
    }
    return fetchImpl(url, init);
  } }), 0);
  assert.deepEqual(JSON.parse(await readFile(f.paths.configFile, 'utf8')).chatIds, ['oc_created']);
});

test('completed setup is idempotent; only --new-app or failed saved token registers again', async t => {
  const f = await fixture(t); assert.equal(await f.run(), 0);
  assert.equal(await f.run(), 0); assert.equal(f.registrations, 1);
  assert.equal(f.calls.filter(c => c.url.includes('/messages?')).length, 1);
  assert.equal(await f.run({ newApp: true }), 0); assert.equal(f.registrations, 2);
  const fetchImpl = f.options.fetchImpl;
  assert.equal(await f.run({ fetchImpl: async (url, init) => {
    if (url.endsWith('/internal') && JSON.parse(init.body).app_id === 'cli_app2') throw new Error('unusable saved app');
    return fetchImpl(url, init);
  } }), 0);
  assert.equal(f.registrations, 3);
});

test('setup adopts usable dotenv credentials even if progress was not written yet', async t => {
  const f = await fixture(t);
  await writeFile(f.paths.envFile, 'FEISHU_APP_ID=cli_saved\nFEISHU_APP_SECRET=saved_secret\n');
  assert.equal(await f.run({ operator: 'ou_saved' }), 0);
  assert.equal(f.registrations, 0);
  assert.deepEqual((await f.progress()).registered, { app_id: 'cli_saved' });
});

test('ambiguous welcome retry uses the saved UUID and does not repeat group creation', async t => {
  const f = await fixture(t); const fetchImpl = f.options.fetchImpl; let uuid;
  assert.equal(await f.run({ fetchImpl: async (url, init) => {
    if (url.includes('/messages?')) {
      uuid = JSON.parse(init.body).uuid;
      throw new Error('welcome response lost');
    }
    return fetchImpl(url, init);
  } }), 1);
  assert.equal(await f.run(), 0);
  assert.equal(f.calls.find(c => c.url.includes('/messages?')).body.uuid, uuid);
  assert.equal(f.calls.filter(c => c.url.includes('/chats?') && c.method === 'POST').length, 1);
});
