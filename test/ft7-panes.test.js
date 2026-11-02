import test from 'node:test';
import assert from 'node:assert/strict';
import { paneLabel } from '../src/panes.js';
import { harness, message } from './helpers.js';

test('pane summaries use titles, Chinese agent states, home paths, ownership and binding with id last', () => {
  const pane = { pane_id: 'w1:p2', terminal_title_stripped: 'Metame 飞书双端同步', foreground_cwd: '/home/me', agent: 'claude' };
  for (const [status, chinese] of Object.entries({ idle: '空闲', working: '工作中', blocked: '等待你确认', done: '已完成', other: '状态待更新' })) {
    assert.equal(paneLabel({ ...pane, agent_status: status }, { home: '/home/me' }),
      `Metame 飞书双端同步 · Claude · ${chinese} · 目录 ~ · 电脑端已有 · 未绑定`);
  }
  assert.equal(paneLabel({ pane_id: 'p', foreground_cwd: '/home/me/project' }, { home: '/home/me', owned: true, bound: true }),
    'project · 命令行 · 目录 ~/project · 从飞书新开 · 已绑定话题');
  assert.match(paneLabel({ pane_id: 'p', foreground_cwd: '/home/me2' }, { home: '/home/me' }), / · 目录 \/home\/me2 · /);
  assert.match(paneLabel({ pane_id: 'p', foreground_cwd: 'C:\\Users\\me\\project' }, { home: 'C:\\Users\\me' }), /project · 命令行 · 目录 ~\/project/);
  assert.match(paneLabel({ pane_id: 'p' }), /终端 · 命令行 · 目录 未提供/);
});

test('screen and topic headers use pane summaries and ownership persists after unbind and restart', async t => {
  const h = await harness(t);
  await h.bridge.handle(message('pwd'));
  Object.assign(h.fake.panes.get('w1:p1'), { terminal_title_stripped: 'My shell', foreground_cwd: '/tmp' });
  await h.bridge.tick();
  const card = h.feishu.calls.find(c => c.msgType === 'interactive').content;
  assert.match(card.header.title.content, /命令行 · 空闲 · My shell · 命令行 · 目录 \/tmp · 从飞书新开 · 已绑定话题$/);
  assert.ok(!card.header.title.content.includes('w1:p1'));
  assert.match(card.elements.at(-1).elements[0].content, /<font color='grey'>w1:p1<\/font>/);
  h.fake.panes.get('w1:p1').terminal_title_stripped = 'New title'; h.advance(1000); await h.bridge.tick();
  assert.match(h.feishu.calls.findLast(c => c.type === 'patch').card.header.title.content, /New title/);
  await h.store.unbind('oc_test', 'm1');
  await h.restart();
  assert.match(h.bridge.label(h.fake.panes.get('w1:p1')), /从飞书新开 · 未绑定/);
  await h.bridge.handle(message('/t open w1:p1', 'open'));
  assert.match(h.feishu.calls.find(c => c.type === 'send').text, /^终端：New title · 命令行/);
  const desktop = h.fake.create();
  assert.match(h.bridge.label(desktop), /电脑端已有 · 未绑定/);
});
