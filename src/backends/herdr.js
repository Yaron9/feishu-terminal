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
    return Promise.all(panes.map(p => this.withProcess({ ...p, ...agents.find(a => a.pane_id === p.pane_id), backendLabel: '旧 herdr' })));
  }
  async withProcess(term) {
    try {
      const { process_info: info } = await this.client.request('pane.process_info', { pane_id: term.pane_id });
      if (info?.pane_id !== term.pane_id) return term;
      const foreground = info.foreground_processes?.find(p => p.pid === info.foreground_process_group_id) ??
        info.foreground_processes?.find(p => p.name === term.agent) ?? info.foreground_processes?.[0];
      return { ...term, foreground, foreground_pid: foreground?.pid ?? info.foreground_process_group_id ?? info.shell_pid ?? null };
    } catch { return term; } // Older servers may lack process_info; /proc env remains authoritative.
  }
  async get(id, options) {
    const { pane } = await this.client.request('pane.get', { pane_id: id });
    if (options) {
      const { workspaces } = await this.client.request('workspace.list');
      if (!pane?.terminal_id || !pane.tab_id || !workspaces.some(w => w.workspace_id === pane.workspace_id &&
          (options.allowDesktop || w.label === 'feishu'))) throw Object.assign(new Error('Unconfirmed terminal identity'), { code: 'identity_mismatch', identityProof: true });
    }
    if (pane?.pane_id !== id) throw Object.assign(new Error('Unconfirmed terminal identity'), { code: 'identity_mismatch', identityProof: true });
    return options ? pane : this.withProcess(pane);
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
    const params = { cwd, focus: false };
    const result = matching.length
      ? await this.client.request('tab.create', { ...params, workspace_id: matching[0].workspace_id })
      : await this.client.request('workspace.create', { ...params, label: 'feishu' });
    if (cmd) await this.sendText(result.root_pane.pane_id, cmd, { submit: true });
    return result.root_pane;
  }
  subscribe(ids, onEvent, onState) { return this.client.subscribe(paneSubscriptions(ids), onEvent, onState); }
  identity(t) { return { terminalId: t.terminal_id, workspaceId: t.workspace_id, tabId: t.tab_id }; }
  processOf(t) { return t.foreground_pid ?? t.foreground?.pid ?? t.pid ?? null; }
  status(t) { return t.agent_status ?? 'unknown'; }
  dispose() { this.client.close(); }
}
