import { registerApp as sdkRegisterApp } from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { runtimePaths } from './runtime.js';
import { acquireLock } from './instance-lock.js';

export const NEEDED_SCOPES = ['im:chat:create', 'im:chat:read', 'im:chat:readonly', 'im:message.group_at_msg:readonly',
  'im:message.group_msg', 'im:message:send_as_bot', 'im:message:readonly'];

export const WELCOME = 'VPS 终端已就绪。新发一个话题（例如 pwd）即可创建终端；在话题内回复会发送到同一终端。\n' +
  '/t ls 列出终端；/t open <pane_id> 绑定已有终端；/t screen 刷新屏幕；/t k ctrl+c 发送按键；' +
  '/t raw <text> 只输入、不回车；/t close 解除绑定；/t close --kill 关闭终端。\n' +
  '等待操作时卡片显示 Enter、Esc、1/2/3、y/n、Ctrl-C 按钮，点击发送对应按键；Refresh 刷新屏幕。' +
  '仅群内授权操作者可以控制。全群消息权限审批完成前，每条消息（包括新话题和话题内回复）都必须 @机器人。';

export class SetupError extends Error {
  constructor(code, { status, platformCode } = {}) {
    super(code); this.code = code;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    if (Number.isSafeInteger(platformCode) && platformCode >= 0) this.platformCode = platformCode;
  }
}

// Private temporary files, fsync, then atomic replacement on the same filesystem.
export async function atomicPrivateWrite(file, content) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
    await rename(temp, file);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close();
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readOptional(file, fallback) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function saveCredentials(file, appId, appSecret) {
  // Values must be single-line literals compatible with dotenv and systemd.
  if (typeof appId !== 'string' || typeof appSecret !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(appId) || !/^[A-Za-z0-9_-]+$/.test(appSecret)) throw new SetupError('invalid_credentials');
  const previous = await readOptional(file, null);
  if (previous !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
    await atomicPrivateWrite(`${file}.bak-${stamp}`, previous);
  }
  const newline = previous?.includes('\r\n') ? '\r\n' : '\n';
  const values = { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret };
  const seen = new Set();
  const lines = (previous ?? '').split(/\r?\n/).filter(line => {
    const key = /^\s*(?:export\s+)?(FEISHU_APP_ID|FEISHU_APP_SECRET)\s*=/.exec(line)?.[1];
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(line => {
    const key = /^\s*(?:export\s+)?(FEISHU_APP_ID|FEISHU_APP_SECRET)\s*=/.exec(line)?.[1];
    return key ? `${key}=${values[key]}` : line;
  });
  if (lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  await atomicPrivateWrite(file, lines.join(newline) + newline);
}

export function setupApi({ fetchImpl = fetch, base = 'https://open.feishu.cn', sleep = delay, signal } = {}) {
  return async (path, { method = 'GET', body, token } = {}) => {
    for (let attempt = 0; ; attempt++) {
      let response, data;
      try {
        const timeout = AbortSignal.timeout(15000);
        response = await fetchImpl(base + path, { method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        data = await response.json();
      } catch { throw new SetupError('network_error'); }
      if ((response.status === 429 || [99991400, 230020].includes(data.code)) && attempt < 4) {
        const retry = Number(response.headers?.get('retry-after')) || 0;
        await sleep(Math.max(1000 * 2 ** attempt, Math.min(30000, retry * 1000))); continue;
      }
      if (!response.ok || (data.code !== undefined && data.code !== 0)) throw new SetupError('api_failed', { status: response.status, platformCode: data.code });
      return data;
    }
  };
}

export async function setup({ newGroup = false, newApp = false, operator, paths = runtimePaths(), registerApp = sdkRegisterApp,
  fetchImpl = fetch, stdout = line => console.log(line), stderr = line => console.error(line), sleep = delay, signal } = {}) {
  let release, ready = Promise.resolve(), stage = 'registration';
  const abort = new AbortController();
  const registrationSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  try {
    stderr(`CONFIG ${resolve(paths.configFile)}`);
    await mkdir(dirname(paths.configFile), { recursive: true, mode: 0o700 });
    release = await acquireLock(paths.configFile + '.setup.lock');
    const config = JSON.parse(await readOptional(paths.configFile, '{}'));
    const progressFile = join(paths.stateDir, 'setup-progress.json');
    let progress = JSON.parse(await readOptional(progressFile, '{}'));
    const saveProgress = () => atomicPrivateWrite(progressFile, JSON.stringify(progress, null, 2) + '\n');
    const env = parseEnv(await readOptional(paths.envFile, ''));
    const api = setupApi({ fetchImpl, sleep, signal: registrationSignal });
    const tokenFor = async (appId, appSecret) => {
      stage = 'tenant_token';
      const auth = await api('/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', body: { app_id: appId, app_secret: appSecret } });
      if (!auth.tenant_access_token) throw new SetupError('missing_tenant_token');
      return auth.tenant_access_token;
    };
    let saved = !newApp && Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET), token;
    if (saved) {
      if (progress.registered?.app_id !== env.FEISHU_APP_ID) {
        progress = { registered: { app_id: env.FEISHU_APP_ID }, operator_open_id: config.operatorOpenIds?.[0] };
      }
      if (progress.tenant_brand === 'lark') throw new SetupError('lark_tenant_unsupported');
      try { token = await tokenFor(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET); }
      catch { saved = false; }
    }
    stage = 'registration';
    const result = saved ? { client_id: env.FEISHU_APP_ID, client_secret: env.FEISHU_APP_SECRET,
      user_info: { open_id: progress.operator_open_id, tenant_brand: progress.tenant_brand } } : await registerApp({ createOnly: true,
      appPreset: { name: 'VPS 终端', desc: '飞书话题 ↔ VPS herdr 终端' },
      addons: { preset: true, scopes: { tenant: ['im:message.group_msg', 'im:chat:readonly'] } }, signal: registrationSignal,
      onQRCodeReady({ url, expireIn }) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !['open.feishu.cn', 'open.larksuite.com'].includes(parsed.hostname)) throw new SetupError('invalid_setup_url');
        const expires = new Date(Date.now() + expireIn * 1000).toISOString();
        const text = `SETUP_URL ${url}\nSETUP_EXPIRES ${expires}\n`;
        ready = atomicPrivateWrite(join(paths.stateDir, 'setup-url.txt'), text).then(() => {
          stdout(`SETUP_URL ${url}`); stdout(`SETUP_EXPIRES ${expires}`);
        });
        // The SDK callback is synchronous; keep a handled promise and abort on IO failure.
        ready.catch(() => abort.abort());
      },
      onStatusChange({ status }) {
        if (status === 'slow_down') stderr('SETUP slow_down: SDK 已自动延长轮询间隔。');
        if (status === 'domain_switched') stderr('SETUP domain_switched');
      },
    });
    await ready;
    const openId = operator ?? result.user_info?.open_id;
    if (!saved) {
      stage = 'credentials';
      await saveCredentials(paths.envFile, result.client_id, result.client_secret);
      progress = { registered: { app_id: result.client_id }, tenant_brand: result.user_info?.tenant_brand };
    }
    if (/^ou_[A-Za-z0-9]+$/.test(openId ?? '')) progress.operator_open_id = openId;
    await saveProgress();
    if (!/^ou_[A-Za-z0-9]+$/.test(openId ?? '')) throw new SetupError('missing_operator');
    // Keep the product on Feishu; never send Lark credentials to Feishu endpoints.
    if (result.user_info?.tenant_brand === 'lark') throw new SetupError('lark_tenant_unsupported');
    token ??= await tokenFor(result.client_id, result.client_secret);
    const validChat = id => /^oc_[A-Za-z0-9]+$/.test(id ?? '');
    const isMember = async chatId => {
      stage = 'group_membership';
      // A tenant token checks the current app's bot, not the human operator.
      const response = await api(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/is_in_chat`, { token });
      if (typeof response.data?.is_in_chat !== 'boolean') throw new SetupError('invalid_membership_response');
      return response.data.is_in_chat;
    };
    const resetGroup = () => {
      for (const key of ['group_created', 'configured', 'welcomed', 'scopes_checked', 'welcome_uuid']) delete progress[key];
    };
    if (newGroup && (!progress.new_group || progress.scopes_checked)) {
      resetGroup(); progress.new_group = true; progress.excluded_chat_id = config.chatIds?.[0]; await saveProgress();
    }
    let chatId = progress.group_created?.chat_id ?? (!progress.new_group && config.chatIds?.length === 1 ? config.chatIds[0] : null);
    if (!validChat(chatId)) chatId = null;
    if (chatId && !await isMember(chatId)) { resetGroup(); chatId = null; await saveProgress(); }
    if (!chatId) {
      stage = 'group_lookup';
      const matches = new Set(), pages = new Set(); let pageToken;
      do {
        const query = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) });
        const response = await api(`/open-apis/im/v1/chats?${query}`, { token });
        if (!Array.isArray(response.data?.items)) throw new SetupError('invalid_group_list');
        for (const chat of response.data.items) {
          if (chat.name === 'VPS 终端' && validChat(chat.chat_id) && chat.chat_id !== progress.excluded_chat_id) matches.add(chat.chat_id);
        }
        pageToken = response.data.has_more ? response.data.page_token : null;
        if (response.data.has_more && (!pageToken || pages.has(pageToken))) throw new SetupError('invalid_group_list');
        pages.add(pageToken);
      } while (pageToken);
      if (matches.size > 1) throw new SetupError('ambiguous_setup_groups');
      const candidate = [...matches][0];
      if (candidate && await isMember(candidate)) chatId = candidate;
    }
    if (!chatId) {
      stage = 'group_create';
      const response = await api('/open-apis/im/v1/chats?user_id_type=open_id', { method: 'POST', token,
        body: { name: 'VPS 终端', description: '飞书话题 ↔ VPS herdr 终端', chat_mode: 'group', chat_type: 'private',
          group_message_type: 'thread', owner_id: openId, user_id_list: [openId] } });
      chatId = response.data?.chat_id;
      if (!/^oc_[A-Za-z0-9]+$/.test(chatId ?? '')) throw new SetupError('missing_chat_id');
    }
    if (progress.group_created?.chat_id !== chatId) { resetGroup(); progress.group_created = { chat_id: chatId }; await saveProgress(); }
    const previousConfig = JSON.stringify(config);
    const configChanged = config.chatIds?.[0] !== chatId || config.chatIds?.length !== 1 ||
      config.operatorOpenIds?.[0] !== openId || config.operatorOpenIds?.length !== 1;
    Object.assign(config, { chatIds: [chatId], operatorOpenIds: [openId] });
    if (!config.defaultCwd || config.defaultCwd === '/home/REPLACE_WITH_USER') config.defaultCwd = homedir();
    for (const [key, name] of [['stateFile', 'bridge.json'], ['auditFile', 'audit.jsonl']]) {
      if (!config[key] || config[key] === `./state/${name}`) config[key] = resolve(paths.stateDir, name);
    }
    stage = 'config_write';
    if (!progress.configured || configChanged || JSON.stringify(config) !== previousConfig) {
      await atomicPrivateWrite(paths.configFile, JSON.stringify(config, null, 2) + '\n');
      progress.configured = true; await saveProgress();
    }
    if (!progress.welcomed) {
      stage = 'welcome';
      progress.welcome_uuid ??= randomUUID(); await saveProgress();
      await api('/open-apis/im/v1/messages?receive_id_type=chat_id', { method: 'POST', token,
        body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: WELCOME }), uuid: progress.welcome_uuid } });
      progress.welcomed = true; await saveProgress();
    }
    if (!progress.scopes_checked) {
      stage = 'scopes';
      const grants = await api('/open-apis/application/v6/scopes', { token });
      if (!Array.isArray(grants.data?.scopes)) throw new SetupError('invalid_scope_response');
      const granted = new Set(grants.data.scopes.filter(s => s.grant_status === 1 && s.scope_type !== 'user').map(s => s.scope_name));
      stderr('SCOPE\tGRANT STATUS');
      for (const name of NEEDED_SCOPES) stderr(`${name}\t${granted.has(name) ? 'granted' : 'not granted (pending approval or not requested)'}`);
      if (!granted.has('im:message.group_msg')) stderr('im:message.group_msg 尚未授权（可能待审批）；审批完成前，每条消息（包括新话题和话题内回复）都必须 @机器人。');
      if (NEEDED_SCOPES.filter(name => name !== 'im:message.group_msg').some(name => !granted.has(name))) throw new SetupError('required_scopes_missing');
      progress.scopes_checked = true; await saveProgress();
    }
    stderr('SETUP OK'); return 0;
  } catch (error) {
    await ready.catch(() => {});
    // Never log upstream messages, payloads, credentials, device codes or tokens.
    const denied = ['access_denied', 'expired_token'].includes(error.code);
    const safeCode = error instanceof SetupError ? error.code : 'operation_failed';
    const details = error instanceof SetupError ?
      `${error.status === undefined ? '' : ` http_status=${error.status}`}${error.platformCode === undefined ? '' : ` feishu_code=${error.platformCode}`}` : '';
    stderr(denied ? `SETUP ${error.code}: 请重新运行 setup。` : `SETUP failed (${stage}/${safeCode}${details}): check network, private files, app permissions and group membership.`);
    return denied ? 2 : error.code === 'missing_operator' ? 3 : 1;
  } finally { await release?.(); }
}
