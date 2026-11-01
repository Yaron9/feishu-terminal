import test from 'node:test';
import assert from 'node:assert/strict';
import { paneLabel } from '../src/panes.js';
import { harness, message } from './helpers.js';

test('pane summaries use titles, Chinese agent states, home paths, ownership and binding with id last', () => {
  const pane = { pane_id: 'w1:p2', terminal_title_stripped: 'Metame 飞书双端同步', foreground_cwd: '/home/me', agent: 'claude' };
  for (const [status, chinese] of Object.entries({ idle: '空闲', working: '工作中', blocked: '等待确认', done: '完成', other: '未知' })) {
    assert.equal(paneLabel({ ...pane, agent_status: status }, { home: '/home/me' }),
      `Metame 飞书双端同步 · claude ${chinese} · ~ · 桌面 · 未绑定 (w1:p2)`);
  }
  assert.equal(paneLabel({ pane_id: 'p', foreground_cwd: '/home/me/project' }, { home: '/home/me', owned: true, bound: true }),
    'project · shell · ~/project · 飞书创建 · 已绑定话题 (p)');
  assert.match(paneLabel({ pane_id: 'p', foreground_cwd: '/home/me2' }, { home: '/home/me' }), / · \/home\/me2 · /);
  assert.match(paneLabel({ pane_id: 'p', foreground_cwd: 'C:\\Users\\me\\project' }, { home: 'C:\\Users\\me' }), /project · shell · ~\/project/);
  assert.match(paneLabel({ pane_id: 'p' }), /终端 · shell · 未知目录/);
});

test('screen and topic headers use pane summaries and ownership persists after unbind and restart', async t => {
  const h = await harness(t);
  await h.bridge.handle(message('pwd'));
  Object.assign(h.fake.panes.get('w1:p1'), { terminal_title_stripped: 'My shell', foreground_cwd: '/tmp' });
  await h.bridge.tick();
  const card = h.feishu.calls.find(c => c.msgType === 'interactive').content;
  assert.match(card.header.title.content, /My shell · shell · \/tmp · 飞书创建 · 已绑定话题 \(w1:p1\)$/);
  await h.store.unbind('oc_test', 'm1');
  await h.restart();
  assert.match(h.bridge.label(h.fake.panes.get('w1:p1')), /飞书创建 · 未绑定/);
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  assert.match(h.feishu.calls.find(c => c.type === 'send').text, /^终端：My shell · shell/);
  const desktop = h.fake.create();
  assert.match(h.bridge.label(desktop), /桌面 · 未绑定/);
});
