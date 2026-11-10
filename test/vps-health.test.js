import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthEngine, parseMeminfo, parsePsiTotal, parseOom, parseLegacyState, formatStatus } from '../src/vps-health.js';

const memory = x => ({ MemAvailable:x, MemTotal:1900, SwapTotal:2048, SwapFree:1800 });
const sample = (mem, zombies=[], disk=50, inaccessible=0) => ({memory:memory(mem),zombies,diskPercent:disk,inaccessible});

test('memory and OOM parsers fail closed, and prior guard state migrates', () => {
  assert.equal(parseMeminfo('MemAvailable: 200 kB'),null);
  assert.deepEqual(parseMeminfo('MemTotal: 1945600 kB\nMemAvailable: 512000 kB\nSwapTotal: 1024 kB\nSwapFree: 512 kB\n'),
    {MemTotal:1900,MemAvailable:500,SwapTotal:1,SwapFree:0});
  assert.equal(parsePsiTotal('some avg10=0.00 avg60=0.00 total=12345\nfull total=22'),12345);
  assert.equal(parsePsiTotal('bad'),null);
  assert.equal(parseOom('oom 3\noom_kill 5\n'),5);
  assert.deepEqual(parseLegacyState('low_memory=1\nzombies=12,40\noom_kill=5\nsecret=abc\n'),{low_memory:1,zombies:[12,40],oom_kill:5});
});

test('memory debounce, zombie persistence, disk hysteresis and recovery do not duplicate notifications', async () => {
  const events=[];let saves=0;const engine=new HealthEngine({send:async text=>events.push(text),save:async()=>{saves++;}});
  await engine.scan(sample(250,[42]));assert.equal(events.length,0);
  await engine.scan(sample(250,[42]));assert.equal(events.length,2);
  await engine.scan(sample(250,[42]));assert.equal(events.length,2);
  await engine.scan(sample(500,[],91));assert.equal(events.length,4);
  await engine.scan(sample(500,[],91));assert.equal(events.length,5);
  await engine.scan(sample(500,[],80));assert.equal(events.length,6);
  assert.equal(engine.state.low_memory,0);assert.equal(engine.state.zombie_alert,0);assert.equal(engine.state.disk_alert,0);assert.equal(saves,6);
});

test('a failed alert remains retryable, and OOM counter resets safely', async () => {
  let fail=true;const events=[];const s={oom_kill:5};
  const e=new HealthEngine({state:s,send:async t=>{if(fail)throw new Error('private data');events.push(t);}});
  await e.oom(6);assert.equal(s.oom_kill,5);
  fail=false;await e.oom(6);assert.equal(s.oom_kill,6);assert.equal(events.length,1);
  await e.oom(2);assert.equal(s.oom_kill,2);assert.equal(events.length,1);
  await e.oom(3);assert.equal(events.length,2);
});

test('memory pressure warns after 3 seconds in 10 and recovers after five calm minutes', async () => {
  let clock=0;const events=[];const e=new HealthEngine({send:async t=>events.push(t),now:()=>clock});
  await e.pressure(1000,500);clock=9000;await e.pressure(3001000,400);assert.equal(events.length,1);
  clock=10000;await e.pressure(3001000,400);assert.equal(events.length,1);
  clock=310000;await e.pressure(3001000,500);assert.equal(events.length,2);
  assert.match(events[1],/恢复/);
});

test('status makes traffic provenance and unavailable billing and expiry explicit', () => {
  const text=formatStatus(sample(500),{iface:'ens5',rx:1024**3,tx:2*1024**3,created:'2026-11-02',updated:'2026-11-09'},'Claude 额度测试');
  assert.match(text,/可用 500 \/ 1900 MiB/);assert.match(text,/入站 1\.00 GiB，出站 2\.00 GiB/);
  assert.match(text,/不等同 AWS 计费/);assert.match(text,/账单到期：未接入/);assert.match(text,/模型订阅到期日：数据源未提供/);
  assert.match(formatStatus(null,null,''),/本月网卡流量：暂不可用/);
});
