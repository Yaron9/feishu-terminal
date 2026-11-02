import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, message, pickerEvent } from './helpers.js';

const kills = h => h.fake.calls.filter(c => c.method === 'pane.close');
const patches = h => h.feishu.calls.filter(c => c.type === 'patch');
const result = h => JSON.stringify(patches(h).at(-1).card);
const click = (h, action) => h.bridge.handle(pickerEvent(h, action));

async function replaced(t) {
  const h = await harness(t);
  await h.bridge.handle(message('pwd'));
  const old = h.store.forPane('w1:p1');
  const pane = h.fake.panes.get(old.paneId);
  pane.terminal_id = 'term_replacement';
  await assert.rejects(h.bridge.verify(old), { code: 'binding_unverified' });
  assert.equal(h.store.forPane(old.paneId).frozen, true);
  return { h, old, pane };
}

test('picker opens a replaced frozen pane by rebinding and recovering its existing topic', async t => {
  const { h, old, pane } = await replaced(t);
  await h.bridge.handle(message('/t ls', 'list'));
  const label = JSON.stringify(h.feishu.calls.at(-1).content);
  assert.match(label, /已暂停同步（点打开重新绑定）/);
  assert.doesNotMatch(label, /已绑定话题/);
  assert.deepEqual(h.store.data.actionCards.at(-1).entries[0].identity, {
    terminalId: pane.terminal_id, workspaceId: pane.workspace_id, tabId: pane.tab_id,
  });
  const before = h.feishu.calls.length;
  await click(h, 'open');
  const active = h.store.forPane(old.paneId);
  assert.equal(active.topicId, old.topicId);
  assert.equal(active.frozen, false);
  assert.notEqual(active.generation, old.generation);
  assert.deepEqual(active.identity, { terminalId: pane.terminal_id, workspaceId: pane.workspace_id, tabId: pane.tab_id });
  assert.notEqual(active.cardId, old.cardId);
  const replies = h.feishu.calls.slice(before).filter(c => c.type === 'reply');
  assert.ok(replies.some(c => c.topicId === old.topicId && c.content === '已重新绑定到当前终端'));
  assert.ok(replies.some(c => c.topicId === old.topicId && c.msgType === 'interactive' &&
    JSON.stringify(c.content).includes('📍 已从终端列表恢复')));
  assert.match(result(h), /已在话题.*已置顶/);
  assert.doesNotMatch(JSON.stringify(h.feishu.calls.slice(before)), /终端已变化/);
  assert.equal(h.store.list().length, 1);
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
});

test('frozen picker rows and topic close use live identity and keep desktop/busy confirmation', async t => {
  for (const source of ['list', 'topic']) {
    for (const mode of ['desktop', 'idle', 'working', 'blocked']) {
      const { h, old, pane } = await replaced(t);
      if (mode !== 'desktop') {
        await h.store.transaction(data => { data.createdTerminals.push(pane.terminal_id); });
        h.fake.status(pane.pane_id, mode);
      }
      await h.bridge.handle(source === 'list' ? message('/t ls', 'list') : message('/t close', 'close', old.topicId));
      if (source === 'list') await click(h, 'close');
      assert.match(h.store.data.actionCards.at(-1).entries[0].label, /已暂停同步（点打开重新绑定）/);
      await click(h, 'kill');
      if (mode !== 'idle') {
        assert.equal(kills(h).length, 0, `${source}/${mode}`);
        assert.match(result(h), /确定关闭.*里面的会话会结束/);
        await click(h, 'kill');
      }
      assert.equal(kills(h).length, 1, `${source}/${mode}`);
      assert.equal(h.fake.panes.has(pane.pane_id), false);
      assert.equal(h.store.list().length, 0);
      assert.match(result(h), /已关闭/);
    }
  }
});

test('frozen row unbind leaves the replacement terminal running', async t => {
  const { h, pane } = await replaced(t);
  await h.bridge.handle(message('/t ls', 'list'));
  await click(h, 'close'); await click(h, 'unbind');
  assert.equal(h.store.list().length, 0);
  assert.equal(h.fake.panes.has(pane.pane_id), true);
  assert.equal(kills(h).length, 0);
  assert.match(result(h), /已解绑/);
});

test('frozen row cards still refuse a subsequent identity change before open or confirmed kill', async t => {
  for (const action of ['open', 'kill']) {
    const { h, old, pane } = await replaced(t);
    await h.bridge.handle(message('/t ls', 'list'));
    if (action === 'kill') { await click(h, 'close'); await click(h, 'kill'); }
    pane.terminal_id = 'term_replaced_again';
    await click(h, action);
    assert.match(result(h), /终端已变化，请重新 \/t ls/);
    assert.equal(kills(h).length, 0);
    assert.equal(h.store.forPane(pane.pane_id).generation, old.generation);
    assert.equal(h.store.forPane(pane.pane_id).frozen, true);
    assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0);
  }
});
