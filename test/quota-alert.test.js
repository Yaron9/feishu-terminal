import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuota, evaluateQuota, nextQuotaDelay } from '../src/quota-alert.js';
import { createUsageReader } from '../src/usage.js';
import { createOperatorNotifier } from '../src/notify-operator.js';

const now=Date.parse('2026-11-09T10:00:00Z');
const account=(pct=85,extra={})=>({email:'owner@example.com',organizationUuid:'org-one',usageStatus:'ok',usageFetchedAt:'2026-11-09T10:00:00Z',
  usage:{fiveHour:{pct,resetsAt:'2026-11-09T14:00:00Z'},sevenDay:{pct:10,resetsAt:'2026-11-15T00:00:00Z'}},...extra});
const data=(...accounts)=>({schemaVersion:1,accounts});

test('restarting the app does not immediately repeat a recent quota check', () => {
  assert.equal(nextQuotaDelay(now-60000,now),14*60*1000);
  assert.equal(nextQuotaDelay(now-16*60*1000,now),5000);
  assert.equal(nextQuotaDelay(undefined,now),5000);
});

test('normalized quota separates organizations, masks identity and rejects invalid windows', () => {
  const rows=normalizeQuota(data(account(),account(85,{organizationUuid:'org-two'})),now);
  assert.notEqual(rows[0].id,rows[1].id);assert.equal(rows[0].legacyId,null);assert.match(rows[0].label,/^o\*\*\*@example\.com/);
  assert.equal(rows[0].windows[0].remaining,15);
  const bad=normalizeQuota(data(account(85,{usage:{fiveHour:{pct:true},sevenDay:{pct:101}}})),now)[0];
  assert.equal(bad.fresh,false);assert.deepEqual(bad.windows,[]);
});

test('low quota alerts once, reset jitter does not duplicate, and recovery is reported', async () => {
  const state={},messages=[];const send=async x=>messages.push(x);
  await evaluateQuota(normalizeQuota(data(account()),now),state,send);assert.equal(messages.length,1);assert.match(messages[0],/剩余 15%/);assert.doesNotMatch(messages[0],/owner@example/);
  await evaluateQuota(normalizeQuota(data(account()),now),state,send);assert.equal(messages.length,1);
  const shifted=account(85,{usage:{fiveHour:{pct:85,resetsAt:'2026-11-09T14:05:00Z'},sevenDay:{pct:10,resetsAt:'2026-11-15T00:00:00Z'}}});
  await evaluateQuota(normalizeQuota(data(shifted),now),state,send);assert.equal(messages.length,1);
  await evaluateQuota(normalizeQuota(data(account(75)),now),state,send);assert.equal(messages.length,2);assert.match(messages[1],/恢复/);
});

test('stale or missing quota and failed sends do not claim success', async () => {
  const state={},messages=[];const stale=normalizeQuota(data(account(99,{usageStatus:'relogin_required',lastGoodFetchedAt:'2026-11-08T00:00:00Z',lastGoodUsage:{fiveHour:{pct:99}}})),now);
  await evaluateQuota(stale,state,async t=>messages.push(t));assert.equal(messages.length,0);
  await evaluateQuota(stale,state,async t=>messages.push(t));assert.equal(messages.length,1);assert.match(messages[0],/过期或不可用/);
  const other={};await assert.rejects(evaluateQuota(normalizeQuota(data(account()),now),other,async()=>{throw new Error('secret');}));
  await evaluateQuota(normalizeQuota(data(account()),now),other,async t=>messages.push(t));assert.equal(messages.length,2);assert.match(messages[1],/剩余 15%/);
});

test('status and quota checks share one in-process cswap request and avoid leaking errors', async () => {
  let calls=0, release;const reader=createUsageReader({now:()=>now,memory:async()=>true,run:async()=>{calls++;await new Promise(r=>release=r);return data(account());}});
  const a=reader(), b=reader.raw();await new Promise(r=>setImmediate(r));assert.equal(calls,1);release();
  const [text,raw]=await Promise.all([a,b]);assert.match(text,/Claude 额度/);assert.equal(raw.accounts.length,1);await reader();assert.equal(calls,1);
  const failed=createUsageReader({memory:async()=>{throw new Error('private credential');}});const out=await failed();assert.doesNotMatch(out,/private credential/);
});

test('alert notifier sends only to configured operator using the app transport', async () => {
  const requests=[];const transport={api:async fn=>fn(),client:{im:{message:{create:async req=>{requests.push(req);return {message_id:'m'};}}}}};
  const send=createOperatorNotifier(transport,'ou_abc123');await send('内存提醒');
  assert.equal(requests[0].params.receive_id_type,'open_id');assert.equal(requests[0].data.receive_id,'ou_abc123');assert.deepEqual(JSON.parse(requests[0].data.content),{text:'内存提醒'});
  assert.throws(()=>createOperatorNotifier(transport,'bad'));
});
