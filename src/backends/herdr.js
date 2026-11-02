import { paneSubscriptions } from '../herdr-client.js';
import { readPane } from '../pane-read.js';

// Contract terminals retain the existing pane field names so persisted state
// and the rendering/transcript adapters need no migration.
export class HerdrBackend {
  constructor(client) { this.client = client; this.name = 'herdr'; }
  async list() {
    const [{ panes }, { agents }] = await Promise.all([
      this.client.request('pane.list'), this.client.request('agent.list'),
    ]);
    return panes.map(p => ({ ...p, ...agents.find(a => a.pane_id === p.pane_id), backendLabel: '旧 herdr' }));
  }
  async get(id, options) {
    const { pane } = await this.client.request('pane.get', { pane_id: id });
    if (options) {
      const { workspaces } = await this.client.request('workspace.list');
      if (!pane?.terminal_id || !pane.tab_id || !workspaces.some(w => w.workspace_id === pane.workspace_id &&
          (options.allowDesktop || w.label === 'feishu'))) throw new Error('Unconfirmed terminal identity');
    }
    if (pane?.pane_id !== id) throw new Error('Unconfirmed terminal identity');
    return pane;
  }
  read(id, options) { return readPane(this.client, id, options); }
  async sendText(id, text, { submit = false, beforeSubmit = async () => {} } = {}) {
    if (submit) {
      const agent = (await this.list()).find(p => p.pane_id === id && p.agent);
      if (agent) return this.client.request('agent.prompt', { target: id, text });
    }
    await this.client.request('pane.send_text', { pane_id: id, text });
    if (submit) { await beforeSubmit(); return this.sendKeys(id, ['enter']); }
  }
  sendKeys(id, keys) { return this.client.request('pane.send_keys', { pane_id: id, keys }); }
  close(id) { return this.client.request('pane.close', { pane_id: id }); }
  async create(cmd, cwd) {
    const { workspaces } = await this.client.request('workspace.list');
    const matching = workspaces.filter(w => w.label === 'feishu');
    if (matching.length > 1) throw new Error('Ambiguous feishu workspace');
    const params = { cwd, focus: false, ...(cmd ? { command: cmd } : {}) };
    const result = matching.length
      ? await this.client.request('tab.create', { ...params, workspace_id: matching[0].workspace_id })
      : await this.client.request('workspace.create', { ...params, label: 'feishu' });
    return result.root_pane;
  }
  subscribe(ids, onEvent, onState) { return this.client.subscribe(paneSubscriptions(ids), onEvent, onState); }
  identity(t) { return { terminalId: t.terminal_id, workspaceId: t.workspace_id, tabId: t.tab_id }; }
  processOf(t) { return t.foreground_pid ?? t.foreground?.pid ?? t.pid ?? null; }
  status(t) { return t.agent_status ?? 'unknown'; }
  dispose() { this.client.close(); }
}
