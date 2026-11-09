import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { matchMember } from '../src/members.js';
import { createConfigRegistry } from '../src/registry.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SessionFollow } from '../src/session-follow.js';
import { Backends } from '../src/backends/index.js';
import { HcBackend } from '../src/backends/hc.js';
import { mockFeishu, message } from './helpers.js';

const JIA = { key: 'jia', name: '甲', aliases: ['甲', '小甲'], cwd: 'C:\\fixture\\jia', cli: 'codex',
  instructionsFile: 'C:\\fixture\\personas\\jia.md' };
const YI = { key: 'yi', name: '乙', aliases: ['乙'], cwd: 'C:\\fixture\\yi', cli: 'codex' };

// 1. Pure matcher: the daemon's team-dispatch rule, ported exactly.
test('matchMember ignores a name in the middle of a sentence and @ mentions', () => {
  assert.equal(matchMember('我想问甲一个问题', [JIA]), null);
  assert.equal(matchMember('我想问甲，一个问题', [JIA]), null);
  assert.equal(matchMember('@甲 你好', [JIA]), null);
  assert.equal(matchMember('甲你是谁', [JIA]), null);
  assert.equal(matchMember('', [JIA]), null);
  assert.equal(matchMember('   ', [JIA]), null);
  assert.equal(matchMember('你好', [JIA, YI]), null);
  assert.equal(matchMember('甲乙', [JIA]), null);
});

test('matchMember accepts Chinese and ASCII punctuation after the leading name', () => {
  const cases = ['甲，你是谁？', '甲：你是谁？', '甲: 你是谁？', '甲 你是谁？', '甲, 你是谁？', '甲、你是谁？', '甲\t你是谁？'];
  for (const text of cases) assert.deepEqual(matchMember(text, [JIA])?.prompt, '你是谁？', text);
  // Leading and trailing whitespace is trimmed before the prefix test.
  assert.deepEqual(matchMember('  甲，你是谁？  ', [JIA])?.prompt, '你是谁？');
  assert.equal(matchMember('甲，你是谁？', [JIA]).member.key, 'jia');
});

test('matchMember treats a whole-name message as switch only', () => {
  assert.deepEqual(matchMember('甲', [JIA]), { member: JIA, prompt: '' });
  assert.deepEqual(matchMember(' 甲 ', [JIA]), { member: JIA, prompt: '' });
  assert.equal(matchMember('甲，', [JIA]).prompt, '');
});

test('matchMember is case-insensitive and matches aliases', () => {
  const alice = { key: 'alice', name: 'Alice', aliases: ['Alice', '爱丽丝'] };
  assert.equal(matchMember('alice，hi', [alice]).member.key, 'alice');
  assert.equal(matchMember('ALICE: hi', [alice]).prompt, 'hi');
  assert.equal(matchMember('爱丽丝，你好', [alice]).prompt, '你好');
  assert.deepEqual(matchMember('小甲，你好', [JIA])?.prompt, '你好');
  assert.equal(matchMember('小甲', [JIA])?.prompt, '');
});

test('matchMember lets the first member in team order win', () => {
  const first = { key: 'one', name: '甲', aliases: ['甲', '甲乙'] };
  const second = { key: 'two', name: '甲乙' };
  assert.equal(matchMember('甲乙，你好', [first, second]).member.key, 'one');
  assert.equal(matchMember('甲乙，你好', [second, first]).member.key, 'two');
  // A member without names and a malformed entry never match or throw.
  assert.equal(matchMember('甲，你好', [null, {}, { key: 'empty' }, JIA]).member.key, 'jia');
});

test('the group registry keeps the member roster', () => {
  const registry = createConfigRegistry({ chatIds: ['oc'], groups: { oc: { cli: 'codex', members: [JIA, YI] } } });
  assert.deepEqual(registry.get('oc').members.map(member => member.key), ['jia', 'yi']);
  assert.equal(registry.get('oc').members[0].cwd, 'C:\\fixture\\jia');
});

// 2. Bridge: fake hc backend, no terminal is ever executed.
async function harness(t, { groupCli = 'codex', members = [JIA, YI], timeoutMs = 20000 } = {}) {
  const home = await mkdtemp(new URL('../.test-w16s7b-', import.meta.url));
  const cwd = 'C:\\fixture\\project';
  let time = Date.now(), sequence = 0;
  const now = () => time, terminals = new Map(), calls = [], audits = [], errors = [];
  const h = { home, cwd, calls, terminals, audits, errors, onRun: () => {}, onSleep: () => {} };
  const create = (props = {}) => {
    const address = `t${++sequence}`, pid = 1000 + sequence;
    const terminal = { address, pid, created_ms: time + sequence, state: 'live', cwd: props.cwd ?? cwd, labels: {},
      foreground: { pid, name: 'cmd.exe', argv: ['cmd.exe', '/c', props.line ?? 'powershell.exe'], cwd: props.cwd ?? cwd },
      reported: false, status: null, output: 'ready', ...props };
    terminals.set(address, terminal); return terminal;
  };
  const client = {
    async request(method, params, hello) {
      calls.push({ method, params }); hello?.({ core: { id: 'fixture-core' } });
      const terminal = terminals.get(params.terminal);
      if (method === 'terminal.list') return { terminals: [...terminals.values()] };
      if (method === 'terminal.run') {
        const term = create({ labels: params.labels, cwd: params.cwd, line: params.line, parent: params.parent });
        await h.onRun(term);
        return term;
      }
      if (!terminal) throw Object.assign(new Error('absent'), { code: 'not_found' });
      if (method === 'terminal.get') return terminal;
      if (method === 'terminal.read') return { text: terminal.output };
      if (method === 'terminal.send' || method === 'terminal.keys') return { turn: 0 };
      if (method === 'terminal.kill') { terminal.state = 'finished'; return terminal; }
      throw new Error(method);
    },
    subscribe() { return () => {}; }, close() {}, async raw() {},
  };
  const store = await new Store(join(home, 'state.json')).load(), feishu = mockFeishu(now);
  const backend = new Backends([new HcBackend(client)]);
  const follow = new SessionFollow({ home, procRoot: join(home, 'absent-proc'), now, sleep: async ms => { time += ms; } });
  const config = { chatIds: ['oc_test'], operatorOpenIds: ['ou_test'], defaultCwd: 'C:\\fixture\\default',
    groups: { oc_test: { cwd, ...(groupCli ? { cli: groupCli } : {}), members } } };
  const bridge = new Bridge({ backend, feishu, store, config, now, adapters: {}, sessionFollow: follow,
    audit: async record => audits.push(record), onError: error => errors.push(error),
    wakeOptions: { timeoutMs, sleep: async ms => { time += ms; await h.onSleep(); } } });
  Object.assign(h, { store, feishu, backend, bridge, config, create,
    advance(ms = 2000) { time += ms; },
    sends: () => calls.filter(c => c.method === 'terminal.send'),
    runs: () => calls.filter(c => c.method === 'terminal.run'),
    ready(term, state = 'idle', app = 'codex') { term.reported = true; term.status = { app, state }; },
    binding: topicId => topicId ? store.list().find(item => item.topicId === topicId) : store.list()[0],
    titles: () => feishu.calls.filter(c => c.type === 'reply' && c.msgType === 'interactive').map(c => c.content.header.title.content),
  });
  t.after(async () => { await bridge.stop(); await rm(home, { recursive: true, force: true }); });
  return h;
}

test('a new root message that starts with a member name opens that member topic', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('甲，你是谁？只回一句', 'root-1'));
  // The member's CLI row launches in the member's own cwd — one new session.
  assert.equal(h.runs().length, 1);
  assert.equal(h.runs()[0].params.line, 'codex --no-daemon -c check_for_update_on_startup=false');
  assert.equal(h.runs()[0].params.cwd, JIA.cwd);
  // The stripped text is the first prompt, written once after the CLI is ready.
  assert.equal(h.sends().length, 1);
  assert.equal(h.sends()[0].params.text, '你是谁？只回一句');
  const binding = h.binding('root-1');
  assert.equal(binding.member, 'jia');
  assert.equal(binding.memberName, '甲');
  assert.equal(binding.cli, 'codex');
  assert.equal(binding.cwd, JIA.cwd);
  assert.equal(binding.instructionsFile, JIA.instructionsFile);
  assert.equal(binding.topicRoot.text, '你是谁？只回一句');
  // The topic opens with the member's identity card: `🤖 甲 · Codex`.
  assert.deepEqual(h.titles(), ['🤖 甲 · Codex']);
  assert.equal(binding.memberCardId, h.feishu.calls.find(c => c.type === 'reply').id);
  assert.deepEqual(h.errors, []);
});

test('a name in the middle of a sentence stays an ordinary group topic', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('我想问甲一个问题', 'root-2'));
  const binding = h.binding('root-2');
  assert.equal(binding.member, undefined);
  assert.equal(binding.cwd, h.cwd);
  assert.equal(h.runs()[0].params.cwd, h.cwd);
  assert.equal(h.sends().length, 1);
  assert.equal(h.sends()[0].params.text, '我想问甲一个问题');
  assert.ok(!h.titles().some(title => title.includes('甲')), JSON.stringify(h.titles()));
});

test('a name inside a member topic is plain input and never switches', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('甲，你是谁？', 'root-1'));
  await h.bridge.handle(message('乙，你好', 'reply-1', 'root-1'));
  assert.equal(h.runs().length, 1, 'no second terminal and no member switch');
  assert.equal(h.store.list().length, 1);
  assert.equal(h.sends().at(-1).params.text, '乙，你好');
  assert.equal(h.sends().at(-1).params.terminal, 't1');
  assert.equal(h.binding('root-1').member, 'jia');
  assert.equal(h.feishu.calls.filter(c => c.type === 'send').length, 0, 'never a group message');
});

test('a bare member name opens the topic with the CLI started and no prompt', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('甲，你是谁？', 'root-1'));
  const sent = h.sends().length;
  await h.bridge.handle(message('乙', 'root-b'));
  const binding = h.binding('root-b');
  assert.equal(binding.member, 'yi');
  assert.equal(binding.memberName, '乙');
  assert.equal(binding.dormant, false);
  assert.equal(h.runs().length, 2);
  assert.equal(h.runs()[1].params.cwd, YI.cwd);
  assert.deepEqual(h.runs()[1].params.labels, { 'ft.woken': '1', source: 'feishu-terminal' });
  assert.equal(binding.queuedInputs.length, 0);
  assert.equal(h.sends().length, sent, 'nothing is typed into the waiting CLI');
  assert.equal(binding.topicRoot.text, '乙');
  assert.ok(h.titles().includes('🤖 乙 · Codex'));
});

test('an alias opens the member topic too', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('小甲：帮我看看', 'root-alias'));
  assert.equal(h.binding('root-alias').member, 'jia');
  assert.equal(h.sends()[0].params.text, '帮我看看');
});

test('one group can host two members of the same CLI without sharing a topic', async t => {
  const h = await harness(t);
  h.onRun = term => h.ready(term);
  await h.bridge.handle(message('甲，一', 'root-a'));
  await h.bridge.handle(message('乙，二', 'root-b'));
  const a = h.binding('root-a'), b = h.binding('root-b');
  assert.notEqual(a.topicId, b.topicId);
  assert.notEqual(a.paneId, b.paneId);
  assert.deepEqual([a.member, b.member], ['jia', 'yi']);
  assert.deepEqual([a.cwd, b.cwd], [JIA.cwd, YI.cwd]);
  assert.deepEqual([h.sends()[0].params.text, h.sends()[1].params.text], ['一', '二']);
});

test('/engine inside a member topic stores the engine under group + member only', async t => {
  const h = await harness(t, { timeoutMs: 1000 });
  // The member CLI never reports ready: the topic stays dormant, so the switch
  // retargets it without touching a live terminal.
  await h.bridge.handle(message('甲，你好', 'root-1'));
  await h.bridge.handle(message('/engine claude', 'reply-e', 'root-1'));
  assert.equal(h.store.data.groupEngines?.['oc_test:jia'], 'claude');
  assert.equal(h.store.data.groupEngines?.oc_test, undefined, 'the group default is untouched');
  assert.equal(h.binding('root-1').cli, 'claude');
  // The member's next topic uses the member's engine; the group default stays codex.
  await h.bridge.handle(message('甲，再来', 'root-2'));
  assert.equal(h.runs().at(-1).params.line, 'claude');
  assert.equal(h.store.data.groupEngines?.oc_test, undefined);
});