import test from 'node:test';
import assert from 'node:assert/strict';
import { CLI_TABLE } from '../src/cli-table.js';
import { createConfigRegistry } from '../src/registry.js';

test('group registry preserves optional default CLI and instructions path', () => {
  const registry = createConfigRegistry({ chatIds: ['one', 'two'], groups: {
    one: { cli: 'codex', instructionsFile: 'C:\\project\\SOUL.md' },
  } });
  assert.equal(registry.get('one').cli, 'codex');
  assert.equal(registry.get('one').instructionsFile, 'C:\\project\\SOUL.md');
  assert.equal(registry.get('two').cli, undefined);
});

test('CLI rows declare their interactive launch command', () => {
  assert.deepEqual(CLI_TABLE.map(({ cli, launch }) => [cli, launch]), [
    ['claude', 'claude'], ['codex', 'codex --no-daemon'], ['pi', 'pi'],
  ]);
});
