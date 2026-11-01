import test from 'node:test';
import assert from 'node:assert/strict';
import * as herdrModule from '../src/herdr-client.js';
import { eventually } from './helpers.js';

test('startup herdr probe logs a safe endpoint, retries ping after failure and stops cleanly', async () => {
  let calls = 0;
  const lines = [];
  const herdr = { endpoint: { path: '/test\nsocket' }, async request(method) {
    assert.equal(method, 'ping');
    if (++calls === 1) throw new Error('private upstream payload');
    return {};
  } };
  const stop = herdrModule.monitorHerdr(herdr, { log: line => lines.push(line), retryMs: 5 });
  try {
    await eventually(() => lines.length === 2);
    assert.deepEqual(lines, ['herdr_unreachable /test\\nsocket', 'herdr ok /test\\nsocket']);
    assert.equal(calls, 2);
  } finally { stop(); }
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 2);
});

test('startup herdr probe suppresses pending results and retries after shutdown', async () => {
  let reject;
  const lines = [];
  const stop = herdrModule.monitorHerdr({ endpoint: { host: '127.0.0.1', port: 49450 },
    request: () => new Promise((_resolve, fail) => { reject = fail; }) }, { log: line => lines.push(line), retryMs: 5 });
  stop(); reject(new Error('closed'));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(lines, []);
});
