// Explicit opt-in only. Never part of node --test. Operates only on the
// task-authorized isolated ftest tunnel, never the default/local socket.
import { HerdrClient, paneSubscriptions } from '../src/herdr-client.js';
import { readPane } from '../src/pane-read.js';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import net from 'node:net';

if (process.env.HERDR_TCP !== '127.0.0.1:49450') throw new Error('Set HERDR_TCP=127.0.0.1:49450 for the isolated ftest tunnel');
const client = new HerdrClient({ endpoint: { host: '127.0.0.1', port: 49450 }, timeoutMs: 4000 });
const created = [];
let stop;
try {
  let ping;
  try { ping = await client.request('ping'); }
  catch (error) {
    console.log(`LIVE UNAVAILABLE: isolated tunnel (${error.code}); no changes made.`);
    process.exitCode = 2;
  }
  if (ping) {
    console.log('PING', JSON.stringify(ping));
    const lifecycle = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port: 49450 });
      let responses = 0, buffer = '';
      const timer = setTimeout(() => { socket.destroy(); }, 1500);
      socket.setEncoding('utf8'); socket.on('error', () => {});
      socket.on('connect', () => socket.write(['probe1', 'probe2'].map(id => JSON.stringify({ id, method: 'ping', params: {} })).join('\n') + '\n'));
      socket.on('data', chunk => { buffer += chunk; responses = buffer.split('\n').filter(line => line.trim()).length; });
      socket.on('close', () => { clearTimeout(timer); resolve(responses); });
    });
    console.log('PIPELINED PING RESPONSES', lifecycle, '(of 2; client always uses one connection per request)');
    const { workspaces } = await client.request('workspace.list');
    console.log('EXISTING WORKSPACES', JSON.stringify(workspaces.map(w => ({ workspace_id: w.workspace_id, label: w.label }))));
    const workspace = workspaces.find(w => w.label === 'feishu');
    const result = workspace
      ? await client.request('tab.create', { workspace_id: workspace.workspace_id, cwd: '/tmp', focus: false, label: 'ft1-live-test' })
      : await client.request('workspace.create', { label: 'feishu', cwd: '/tmp', focus: false });
    const pane = result.root_pane; created.push(pane.pane_id);
    console.log('CREATED', JSON.stringify({ workspace_id: pane.workspace_id, pane_id: pane.pane_id }));
    const second = await client.request('tab.create', { workspace_id: pane.workspace_id, cwd: '/tmp', focus: false, label: 'ft1-live-tab-test' });
    created.push(second.root_pane.pane_id);
    console.log('CREATED TAB PANE', second.root_pane.pane_id);
    const events = [];
    let connected = false;
    stop = client.subscribe(paneSubscriptions(created), event => {
      events.push(event);
      console.log('EVENT', JSON.stringify({ event: event.event, pane_id: event.data?.pane_id, status: event.data?.agent_status }));
    }, state => { connected = state === 'connected'; console.log('SUBSCRIPTION', state); });
    for (let i = 0; i < 20 && !connected; i++) await delay(100);
    assert.ok(connected, 'subscription acknowledgement');
    await delay(300); // shell prompt readiness, only in the isolated new pane
    await client.request('pane.send_text', { pane_id: pane.pane_id, text: 'echo hello-ft1' });
    await client.request('pane.send_keys', { pane_id: pane.pane_id, keys: ['enter'] });
    let recent;
    for (let i = 0; i < 30; i++) {
      recent = (await readPane(client, pane.pane_id, { lines: 80 })).read;
      if (recent.text.split('\n').some(line => line.trim() === 'hello-ft1')) break;
      await delay(100);
    }
    assert.ok(recent.text.split('\n').some(line => line.trim() === 'hello-ft1'), 'echo output (not just echoed input)');
    const visible = (await readPane(client, pane.pane_id, { source: 'visible', lines: 40 })).read;
    assert.ok(visible.text.includes('hello-ft1'));
    console.log('READ', JSON.stringify({ visible: visible.text, recent_unwrapped: recent.text, revision: recent.revision }));
    await client.request('pane.send_keys', { pane_id: pane.pane_id, keys: ['ctrl+u'] });
    // Brief shell process changes exercise status events without starting AI.
    await client.request('pane.send_text', { pane_id: pane.pane_id, text: 'sleep 1' });
    await client.request('pane.send_keys', { pane_id: pane.pane_id, keys: ['enter'] });
    await delay(1800);
    assert.ok(events.some(e => e.event === 'pane.output_matched'), 'output subscription delivery');
    console.log('STATUS EVENTS', events.filter(e => /status/.test(e.event)).length,
      '(a shell need not emit agent status transitions; fixture covers working/idle/blocked)');
    console.log('LIVE PASS: create, send_text, send_keys, visible/recent_unwrapped, subscription');
  }
} finally {
  stop?.();
  for (const pane_id of created) {
    try { await client.request('pane.close', { pane_id }); console.log('CLOSED', pane_id); }
    catch (error) { console.error('CLEANUP REQUIRED', pane_id, error.code); process.exitCode = 1; }
  }
  client.close();
}
