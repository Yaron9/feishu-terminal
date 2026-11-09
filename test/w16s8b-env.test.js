import test from 'node:test';
import assert from 'node:assert/strict';
import { callerCommand } from '../src/wake.js';

test('caller environment is safely passed on both platforms', () => {
  const binding = { chatId: 'oc_test', topicId: 'om_test', member: "m'1" };
  const group = { project: 'project' };
  const windows = callerCommand('codex --resume abc', binding, group, 'win32');
  const script = Buffer.from(windows.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /\$env:METAME_FT_CHAT='oc_test'/);
  assert.match(script, /\$env:METAME_FT_TOPIC='om_test'/);
  assert.match(script, /\$env:METAME_PROJECT='project'/);
  assert.match(script, /\$env:METAME_MEMBER='m''1'/);
  assert.match(script, /codex --resume abc$/);
  assert.match(callerCommand('codex', binding, group, 'linux'), /METAME_FT_TOPIC='om_test'/);
});
