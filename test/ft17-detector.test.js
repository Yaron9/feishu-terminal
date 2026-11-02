import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMenu } from '../src/menus.js';
import { resume, numbered, model, config, ordinary } from './fixtures/ft17-menus.js';

test('ft17 detector extracts the live resume title, three sessions, detail lines and cursor, ignoring search/group chrome', () => {
  assert.deepEqual(detectMenu(resume), { kind: 'list', title: 'Resume session', cursorIndex: 0, items: [
    { label: 'Metame 飞书双端同步', sublabel: '4 seconds ago · HEAD · 7.1MB' },
    { label: 'paper30-reloading 研究交接文档', sublabel: '2 hours ago · HEAD · 8.2MB' },
    { label: '钻进robot大脑方案', sublabel: '16 hours ago · HEAD · 8MB' },
  ] });
  assert.deepEqual(detectMenu('\x1b[36m' + resume + '\x1b[0m'), detectMenu(resume));
});

test('ft17 detector separates numbered permissions, list models/config, fixed columns and ordinary quotes/output', () => {
  const permission = detectMenu(numbered);
  assert.equal(permission.kind, 'numbered'); assert.equal(permission.title, 'Allow this command?');
  assert.deepEqual(permission.items.map(item => item.label), ['Yes, execute', 'Always allow', 'No, cancel']);
  assert.equal(permission.cursorIndex, 0);
  assert.deepEqual(detectMenu(model), { kind: 'list', title: 'Select model', cursorIndex: 0, items: [
    { label: 'Default (recommended)', sublabel: 'Use the default model' },
    { label: 'Sonnet', sublabel: 'Balanced speed and quality' },
    { label: 'Haiku', sublabel: 'Fast responses' },
  ] });
  assert.equal(detectMenu(config).cursorIndex, 1);
  assert.equal(detectMenu(config.replace('›', '>')).cursorIndex, 1);
  for (const text of ordinary) assert.equal(detectMenu(text).kind, null, text);
});

test('ft17 same-column dim sublabels attach to items; ambiguous cursors fall back to navigation', () => {
  const screen = 'Select model\n❯ Default\n  \x1b[2mRecommended model\x1b[0m\n\n  Sonnet\n  \x1b[90mBalanced model\x1b[0m\nEsc to cancel';
  assert.deepEqual(detectMenu(screen).items, [
    { label: 'Default', sublabel: 'Recommended model' }, { label: 'Sonnet', sublabel: 'Balanced model' },
  ]);
  const ambiguous = 'Select model\n❯ Default\n❯ Sonnet\nEsc to cancel';
  assert.deepEqual(detectMenu(ambiguous), { kind: 'list', title: 'Select model', items: [], cursorIndex: -1 });
  assert.equal(detectMenu('❯ Default\n  Sonnet').kind, null, 'a cursor and siblings without a menu hint are insufficient');
});

