// Deliberately limited to the self-built app endpoints used by this bridge.
// Feishu.api owns serialization and explicit throttle retries (including UUIDs).
export class FeishuAPI {
  constructor({ appId, appSecret, fetchImpl = fetch, base = 'https://open.feishu.cn', now = Date.now, timeoutMs = 0 } = {}) {
    Object.assign(this, { appId, appSecret, fetchImpl, base, now, timeoutMs });
    const message = '/open-apis/im/v1/messages';
    const path = input => `${message}/${encodeURIComponent(input.path.message_id)}`;
    this.im = { message: {
      create: input => this.request({ method: 'POST', url: message, ...input }),
      reply: input => this.request({ method: 'POST', url: `${path(input)}/reply`, ...input }),
      patch: input => this.request({ method: 'PATCH', url: path(input), ...input }),
      get: input => this.request({ method: 'GET', url: path(input), ...input }),
      list: input => this.request({ method: 'GET', url: message, ...input }),
    } };
  }
  async json(url, { method = 'POST', data, headers = {} } = {}) {
    // The pinned SDK's REST axios instance has timeout=0; endpoint discovery
    // separately uses 15s. Preserve that default and allow a caller deadline.
    let response, body;
    try {
      response = await this.fetchImpl(url, { method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        ...(this.timeoutMs > 0 ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
      });
      body = await response.json();
    } catch {
      const error = new Error('Feishu transport failed'); error.code = 'network_error';
      if (response && !response.ok) error.response = { status: response.status, data: {}, headers: Object.fromEntries(response.headers) };
      throw error;
    }
    if (!response.ok) {
      const error = new Error('Feishu HTTP request failed');
      error.response = { status: response.status, data: body, headers: Object.fromEntries(response.headers) };
      throw error;
    }
    return body;
  }
  async tenantToken() {
    if (this.token && this.now() < this.refreshAt) return this.token;
    if (!this.refresh) this.refresh = (async () => {
      const result = await this.json(this.base + '/open-apis/auth/v3/tenant_access_token/internal',
        { data: { app_id: this.appId, app_secret: this.appSecret } });
      if (result.code || !result.tenant_access_token || !(result.expire > 0)) {
        const error = new Error('Feishu token request failed');
        error.response = { status: 200, data: { ...result, code: result.code || 'missing_tenant_token' } };
        throw error;
      }
      this.token = result.tenant_access_token;
      const lifetime = result.expire * 1000;
      this.refreshAt = this.now() + lifetime - Math.min(180000, lifetime / 2);
      return this.token;
    })().finally(() => { this.refresh = null; });
    return this.refresh;
  }
  async request({ method, url, params, data }) {
    // Only relative platform paths: never attach a token to another origin.
    if (!url.startsWith('/open-apis/')) throw new Error('Invalid Feishu API path');
    const target = new URL(this.base + url);
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) target.searchParams.set(key, value);
    return this.json(target.href, { method, data, headers: { Authorization: `Bearer ${await this.tenantToken()}` } });
  }
}
