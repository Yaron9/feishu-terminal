import test from 'node:test';
import assert from 'node:assert/strict';
import { route, validKeys } from '../src/router.js';

test('all non-/t payloads, including slash commands, are verbatim', () => {
  for (const text of ['/compact', '/help', '/tmp/a', '/term connect', '/turtle', '  echo a  \n b', ' /t ls', '', '/t/ls']) {
    assert.deepEqual(route(text, true), { type: 'input', text });
    assert.deepEqual(route(text, false), { type: 'create', text });
  }
});
test('reserved commands parse strictly with binding requirements', () => {
  assert.deepEqual(route('/t ls'), { type: 'list' });
  assert.deepEqual(route('/t open w1:p2'), { type: 'open', paneId: 'w1:p2' });
  assert.deepEqual(route('/t close', true), { type: 'close', kill: false });
  assert.deepEqual(route('/t close --kill', true), { type: 'close', kill: true });
  assert.deepEqual(route('/t screen', true), { type: 'screen' });
  assert.deepEqual(route('/t raw  /compact\n ', true), { type: 'raw', text: ' /compact\n ' });
  for (const text of ['/t', '/t ls x', '/t close --force', '/t open', '/t raw', '/t wat']) assert.equal(route(text, true).type, 'error');
  for (const text of ['/t close', '/t screen', '/t k enter', '/t raw a']) assert.equal(route(text, false).type, 'error');
  assert.equal(route(undefined).type, 'error');
});
test('key allowlist rejects the entire batch before sending any keys', () => {
  assert.deepEqual(route('/t k enter esc ctrl+c shift+tab 1 y n tab', true), { type: 'keys', keys: ['enter', 'esc', 'ctrl+c', 'shift+tab', '1', 'y', 'n', 'tab'] });
  for (const keys of [[], Array(9).fill('enter'), ['ENTER'], ['ctrl+c', 'shell'], ['\x03'], ['enter;rm'], ['0'], ['f999']]) assert.equal(validKeys(keys), false);
  assert.equal(route('/t k ctrl+c invalid', true).type, 'error');
});
