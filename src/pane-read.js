import { HerdrError } from './herdr-client.js';

// Over-reading herdr's buffer can scroll the application itself and trigger
// a full TUI repaint. Fetch fresh limits for every read; never guess a bound.
export async function readPane(herdr, paneId, { source = 'recent_unwrapped', lines = 2000 } = {}) {
  if (!['visible', 'recent', 'recent_unwrapped'].includes(source) || !Number.isSafeInteger(lines) || lines < 1)
    throw new TypeError('Invalid pane read options');
  const { pane } = await herdr.request('pane.get', { pane_id: paneId });
  const rows = pane?.scroll?.viewport_rows, offset = pane?.scroll?.max_offset_from_bottom;
  if (pane?.pane_id !== paneId || !Number.isSafeInteger(rows) || rows < 1 ||
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(rows + offset))
    throw new HerdrError('invalid_scroll');
  if (offset === 0) source = 'visible';
  return herdr.request('pane.read', {
    pane_id: paneId, source, lines: Math.min(lines, source === 'visible' ? rows : rows + offset),
  });
}
