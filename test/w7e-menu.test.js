import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMenu } from '../src/menus.js';

test('Codex update prompt exposes its three numbered choices', () => {
  const screen = '  Update available · 0.164.0 → 0.166.0\n  Release notes: https://github.com/openai/codex/releases/latest\n\n❯ 1. Update now (runs `npm install -g @openai/codex`)\n  2. Skip\n  3. Skip until next version\n\n  enter continue · esc skip';
  for (const status of [undefined, 'waiting', 'working', 'blocked']) {
    const menu = detectMenu(screen, { status, cli: 'codex' });
    assert.equal(menu.kind, 'numbered');
    assert.equal(menu.items.length, 3);
    assert.equal(menu.cursorIndex, 0);
  }
});
