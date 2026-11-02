import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { coreHarness } from './ft25-helper.js';
import { message } from './helpers.js';

async function setup(t, options) {
  const h = await coreHarness(t, options), old = h.herdr.create();
  Object.assign(old, { agent: 'claude', agent_status: 'idle', foreground_pid: 101 });
  await h.process(101, 100, old.pane_id);
  await h.bridge.handle(message(`/t open ${old.pane_id}`, 'open'));
  await h.records([{ type: 'user', uuid: 'u1', message: { content: 'prompt' } },
    { type: 'assistant', message: { content: 'old process output' } }]);
  await h.poll();
  const binding = () => h.store.binding('oc_test', h.store.list()[0].topicId);
  const newer = async (id = 'hc:t1', pid = 202, start = 200) => {
    if (id?.startsWith('hc:')) h.hc.create({ address: id.slice(3), foreground: { pid, name: 'claude', argv: ['claude', '--resume', 'same'], cwd: '/tmp/project' } });
    await h.process(pid, start, id); return pid;
  };
  return { h, old, binding, newer, scan: async () => { h.advance(); await h.bridge.scanSessions(); } };
}

test('newest hc process retargets atomically, preserves topic/cursor/turn/card and SIGTERMs only the old PID', async t => {
  const { h, old, binding, newer, scan } = await setup(t);
  const before = binding(); assert.equal(before.claudeSessionId, 'same');
  await newer();
  h.onKill(() => {
    assert.equal(binding().paneId, 'hc:t1', 'durable retarget precedes SIGTERM');
    assert.notEqual(binding().generation, before.generation);
  });
  await scan(); const after = binding();
  assert.equal(after.paneId, 'hc:t1'); assert.equal(after.topicId, before.topicId);
  assert.deepEqual(after.transcript, before.transcript); assert.deepEqual(after.turn, before.turn);
  assert.equal(after.cardId, before.cardId); assert.equal(after.cardTurnId, before.cardTurnId);
  assert.notDeepEqual(after.identity, before.identity); assert.notEqual(after.nonce, before.nonce);
  assert.deepEqual(h.kills, [{ pid: 101, signal: 'SIGTERM' }]);
  assert.ok(h.audits.some(r => r.action === 'session_retarget' && r.winner_pid === 202 && r.older_pids.includes(101)));
  assert.ok(h.audits.some(r => r.action === 'session_terminate' && r.pid === 101));
  const notes = () => h.feishu.calls.filter(c => JSON.stringify(c.content ?? '').includes('会话已转到'));
  assert.equal(notes().length, 1); assert.match(JSON.stringify(notes()[0].content), /grey.*herdr-core hc:t1，旧进程已结束/);
  await assert.rejects(h.bridge.verify(before), { code: 'binding_changed' });
  await h.bridge.handle(message('phone goes to new core', 'phone', before.topicId));
  assert.equal(h.hc.calls.filter(c => c.method === 'terminal.send').at(-1).params.text, 'phone goes to new core');
  await h.records([{ type: 'assistant', message: { content: 'new process output' } }]); await h.poll();
  assert.equal(binding().cardId, before.cardId);
  assert.ok(h.feishu.calls.some(c => c.type === 'patch' && c.id === before.cardId && JSON.stringify(c.card).includes('new process output')));
  await scan(); assert.equal(notes().length, 1); assert.equal(h.kills.length, 1);
  assert.equal(h.store.forPane(old.pane_id), undefined);
  assert.ok(!JSON.stringify(h.audits).includes('never-log'));
});

test('bare SSH winner and warn mode preserve ft24 duplicate warning and never terminate', async t => {
  for (const options of [{ sessionFollow: 'newest' }, { sessionFollow: 'warn' }]) {
    const { h, old, binding, newer } = await setup(t, options);
    await newer(options.sessionFollow === 'warn' ? 'hc:t1' : null);
    await h.poll(); assert.equal(binding().paneId, old.pane_id); assert.deepEqual(h.kills, []);
    assert.match(binding().turn.duplicateWarning, /PID 202/);
    assert.ok(h.feishu.calls.some(c => typeof c.content === 'string' && c.content.includes('PID 202')));
  }
});

test('SIGTERM re-verifies comm, sessionId, start time and the winning process after audit', async t => {
  for (const mutation of ['comm', 'session', 'start', 'winner']) {
    const { h, binding, newer, scan } = await setup(t); await newer();
    h.auditHook(async record => {
      if (record.action !== 'session_terminate_intent') return;
      if (mutation === 'comm') await writeFile(join(h.proc, '101', 'comm'), 'bash\n');
      if (mutation === 'session') await writeFile(join(h.sessions, '101.json'), JSON.stringify({ pid: 101, sessionId: 'other' }));
      if (mutation === 'start') await h.process(101, 999, 'w1:p1');
      if (mutation === 'winner') await writeFile(join(h.proc, '202', 'comm'), 'bash\n');
    });
    await scan(); assert.equal(binding().paneId, 'hc:t1'); assert.deepEqual(h.kills, [], mutation);
    assert.match(JSON.stringify(h.feishu.calls.findLast(c => c.content?.body?.elements?.[0]?.content.includes('会话已转到')).content), /旧进程仍需检查/);
  }
});

test('surviving older process waits at most ten seconds, reports PID and never SIGKILLs or re-signals', async t => {
  const { h, binding, newer, scan } = await setup(t, { survive: true }); await newer();
  const before = h.now(); await scan(); assert.equal(h.now() - before, 12000);
  assert.equal(binding().sessionHandoff.older[0].outcome, 'still_alive');
  assert.deepEqual(h.kills, [{ pid: 101, signal: 'SIGTERM' }]);
  assert.ok(h.feishu.calls.some(c => JSON.stringify(c.content ?? '').includes('PID 101')));
  await scan(); assert.equal(h.kills.length, 1);
});

test('newest uses proc start time, supports reverse hc-to-herdr migration and ignores dead/non-Claude sessions', async t => {
  const { h, old, binding, newer, scan } = await setup(t);
  await newer('hc:t1', 50, 200); await h.process(999, 900, null, { comm: 'bash' });
  await h.process(888, 800, null); await rm(join(h.proc, '888'), { recursive: true });
  await scan(); assert.equal(binding().paneId, 'hc:t1'); assert.equal(h.kills[0].pid, 101);
  const target = h.herdr.create(); Object.assign(target, { agent: 'claude', agent_status: 'idle', foreground_pid: 30 });
  await h.process(30, 300, target.pane_id); await scan();
  assert.equal(binding().paneId, target.pane_id); assert.deepEqual(h.kills.map(k => k.pid), [101, 50]);
  assert.ok(!h.kills.some(k => k.signal === 'SIGKILL'));
  assert.equal(h.store.forPane(old.pane_id), undefined);
});

test('a newer sole live process follows after the old process exited; occupied target remains untouched', async t => {
  const { h, old, binding, newer, scan } = await setup(t);
  await newer(); await rm(join(h.proc, '101'), { recursive: true }); await scan();
  assert.equal(binding().paneId, 'hc:t1'); assert.deepEqual(h.kills, []);
  const target = h.herdr.create(); Object.assign(target, { agent: 'claude', agent_status: 'idle', foreground_pid: 303 });
  await h.bridge.handle(message(`/t open ${target.pane_id}`, 'other'));
  await h.process(303, 300, target.pane_id); await scan();
  assert.equal(binding().paneId, 'hc:t1'); assert.deepEqual(h.kills, []);
  assert.equal(h.store.list().length, 2); assert.equal(h.store.forPane(old.pane_id), undefined);
});

test('handoff resumes persisted cleanup without repeating a claimed signal or changing transcript cursor', async t => {
  const { h, binding, newer, scan } = await setup(t); await newer();
  h.auditHook(record => { if (record.action === 'session_retarget') throw new Error('crash'); });
  const before = binding(); await scan(); assert.equal(binding().paneId, 'hc:t1'); assert.deepEqual(h.kills, []);
  h.auditHook(() => {}); await scan(); assert.equal(h.kills.length, 1);
  assert.deepEqual(binding().transcript, before.transcript);
  assert.equal(JSON.parse(await readFile(h.store.file, 'utf8')).bindings[0].sessionHandoff.done, true);
});

test('pre-ft25 cursor discovers session ID and follows even when the old terminal is gone', async t => {
  const { h, old, binding, newer, scan } = await setup(t);
  const before = binding();
  await h.store.update(before.chatId, before.topicId, { claudeSessionId: null });
  h.herdr.panes.delete(old.pane_id); await rm(join(h.proc, '101'), { recursive: true });
  await newer(); await scan();
  assert.equal(binding().paneId, 'hc:t1'); assert.equal(binding().claudeSessionId, 'same');
  assert.deepEqual(binding().transcript, before.transcript); assert.deepEqual(binding().turn, before.turn);
});

test('retarget preserves an uncertain publication UUID and batch generation without reviving its nonce', async t => {
  const { h, binding, newer, scan } = await setup(t);
  await h.records([{ type: 'user', uuid: 'next', message: { content: 'next prompt' } },
    { type: 'assistant', message: { content: 'next output' } }]);
  const reply = h.feishu.reply.bind(h.feishu); let lost;
  h.feishu.reply = async (topic, content, type, uuid) => {
    if (content?.header?.title?.content.startsWith('🤖 ')) {
      const id = await reply(topic, content, type, uuid); lost = { id, uuid, content }; throw new Error('response lost');
    }
    return reply(topic, content, type, uuid);
  };
  await h.poll(); const pending = binding().pendingCard, batch = binding().outputBatch;
  assert.ok(pending); assert.ok(batch); assert.equal(pending.uuid, lost.uuid);
  await newer(); await scan();
  assert.equal(binding().pendingCard.uuid, pending.uuid); assert.deepEqual(binding().pendingCard.card, pending.card);
  assert.equal(binding().outputBatch.generation, binding().generation);
  assert.equal(binding().outputBatch.next, batch.next);
  h.feishu.reply = async (topic, content, type, uuid) => {
    if (uuid === lost.uuid) { assert.deepEqual(content, lost.content); return lost.id; }
    return reply(topic, content, type, uuid);
  };
  await h.poll(); assert.equal(binding().cardId, lost.id); assert.notEqual(binding().nonce, pending.nonce);
  assert.equal(h.feishu.calls.filter(c => c.uuid === lost.uuid).length, 1);
});

test('a changed winner terminal identity during the termination audit cannot signal an older process', async t => {
  const { h, binding, newer, scan } = await setup(t); await newer();
  h.auditHook(record => { if (record.action === 'session_terminate_intent') h.hc.coreId('replaced'); });
  await scan(); assert.deepEqual(h.kills, []); assert.equal(binding().frozen, true);
});

test('Feishu resume starts hc once without a competing binding, then the original topic follows', async t => {
  const { h, binding, scan } = await setup(t), before = binding();
  const request = message('claude --resume same', 'phone-resume');
  await h.bridge.handle(request); await h.bridge.handle(request);
  assert.equal(h.store.list().length, 1); assert.equal(binding().topicId, before.topicId);
  const runs = h.hc.calls.filter(c => c.method === 'terminal.run'); assert.equal(runs.length, 1);
  assert.equal(runs[0].params.line, 'claude --resume same');
  assert.equal(h.hc.calls.filter(c => c.method === 'terminal.send').length, 0);
  assert.ok(h.store.data.topicPointers.some(p => p.oldTopicId === request.messageId && p.topicId === before.topicId));
  const term = h.hc.terminals.get('t1'); term.foreground = { pid: 202, name: 'claude', argv: ['claude'], cwd: '/tmp/project' };
  await h.process(202, 200, 'hc:t1'); await scan();
  assert.equal(binding().paneId, 'hc:t1'); assert.equal(binding().cardId, before.cardId);
  assert.deepEqual(h.kills, [{ pid: 101, signal: 'SIGTERM' }]);
});
