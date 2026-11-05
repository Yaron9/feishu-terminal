import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyHarness, message } from './helpers.js';

for (const cli of ['claude', 'codex']) {
  async function setup(t) {
    const records = [];
    const adapter = { locate: async () => 'fake.jsonl', read: async (_path, cursor) => ({
      cursor: { offset: records.length }, items: cursor.atEnd ? [] : records.slice(cursor.offset),
    }) };
    const h = await legacyHarness(t, { adapters: { [cli]: adapter } });
    const pane = h.fake.create(); Object.assign(pane, { agent: cli, agent_status: 'working', visible: 'Ready' });
    await h.bridge.handle(message('/t open w1:p1', 'open'));
    const binding = () => h.bridge.store.forPane('w1:p1');
    const poll = async ms => { h.advance(ms); h.bridge.state(binding()).dirty = true; await h.bridge.tick(); };
    const send = (text, id) => h.bridge.handle(message(text, id, binding().topicId));
    const replies = () => h.feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive');
    const patches = () => h.feishu.calls.filter(c => c.type === 'patch');
    return { h, pane, records, binding, poll, send, replies, patches };
  }
  test(`${cli}: screen fallback survives restart and late transcript, and next prompt creates a card`, async t => {
    const x = await setup(t);
    await x.send('/status', 'one'); x.pane.visible = 'Status panel\nDetails';
    await x.poll(2999); assert.equal(x.replies().length, 0); assert.equal(x.patches().length, 0);
    await x.poll(1); assert.equal(x.replies().length, 1);
    const id = x.binding().cardId; assert.match(JSON.stringify(x.replies()[0].content), /Status panel/);
    await x.h.restart(); await x.poll(2000); assert.equal(x.replies().length, 1); assert.equal(x.patches().length, 0);
    x.records.push({ role: 'user', text: '/status' }, { role: 'assistant', text: 'Late answer' });
    await x.poll(2000); assert.equal(x.replies().length, 1); assert.equal(x.binding().cardId, id);
    assert.match(JSON.stringify(x.patches().at(-1)), /Late answer/);
    await x.send('/diff', 'two'); x.pane.visible = 'Diff panel'; await x.poll(3000);
    assert.equal(x.replies().length, 2); assert.notEqual(x.binding().cardId, id);
  });
  test(`${cli}: a picker and its choice continue on the same input card`, async t => {
    const x = await setup(t);
    await x.send('/model', 'picker');
    x.pane.agent_status = 'blocked'; x.pane.visible = 'Select model\n? First model\n  Second model\nEsc to cancel';
    await x.poll(1000); const b = x.binding(), id = b.cardId;
    assert.ok(id); assert.equal(b.menuCardId, id); assert.equal(x.replies().length, 1);
    await x.h.bridge.handle({ kind: 'button', eventId: 'choice', chatId: b.chatId, topicId: b.topicId,
      openId: 'ou_test', messageId: id, nonce: b.menuNonce, key: 'menu:select:1' });
    x.pane.agent_status = 'working'; x.pane.visible = 'Model selected';
    await x.poll(2000); assert.equal(x.binding().cardId, id); assert.equal(x.replies().length, 1);
    x.records.push({ role: 'assistant', text: 'Choice completed' }); await x.poll(2000);
    assert.equal(x.binding().cardId, id); assert.equal(x.replies().length, 1);
    assert.match(JSON.stringify(x.patches().at(-1)), /Choice completed/);
  });
  test(`${cli}: early transcript skips screen fallback and matches an ordinary turn`, async t => {
    const x = await setup(t);
    await x.send('hello', 'hello'); x.pane.visible = 'temporary screen';
    await x.poll(1000); assert.equal(x.replies().length, 0);
    x.records.push({ role: 'user', text: 'hello' }, { role: 'assistant', text: 'Clean answer' });
    await x.poll(1000); assert.equal(x.replies().length, 1);
    const card = JSON.stringify(x.replies()[0].content); assert.match(card, /Clean answer/); assert.doesNotMatch(card, /temporary screen/);
    await x.poll(2000); assert.equal(x.replies().length, 1); assert.equal(x.patches().length, 0);
  });
}
