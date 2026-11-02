export const KEYS = new Set([
  'enter', 'esc', 'tab', 'up', 'down', 'left', 'right', 'ctrl+c', 'ctrl+u',
  'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'shift+tab',
  'home', 'end', 'backspace', 'delete', 'pageup', 'pagedown',
]);

export function validKeys(keys) {
  return Array.isArray(keys) && keys.length >= 1 && keys.length <= 8 && keys.every(key => KEYS.has(key));
}

export const HELP = '/t ls | /t open <pane_id> | /t move [<pane_id>] | /t close [--kill] | /t k <1–8 keys> | /t screen | /t raw <text> | /t ok';

// Nothing except the exact /t token is reserved. Payload whitespace is data.
export function route(text, bound = false) {
  if (typeof text !== 'string') return { type: 'error', message: 'Only text messages are supported.' };
  if (!/^\/t(?:\s|$)/u.test(text)) return { type: bound ? 'input' : 'create', text };
  const raw = /^\/t\s+raw(?:[ \t]|\r?\n)([\s\S]*)$/u.exec(text);
  if (raw) return bound ? { type: 'raw', text: raw[1] } : { type: 'error', message: 'Open a topic first.' };
  const parts = text.trim().split(/\s+/u).slice(1);
  // Phone smart punctuation applies only to option tokens in this grammar.
  // Raw payloads and ordinary terminal input have already returned verbatim.
  if (parts[0] === 'close' && parts.length > 1) parts[1] = parts[1].replace(/^[—–](?=[a-z])/iu, '--');
  if (parts[0] === 'ls' && parts.length === 1) return { type: 'list' };
  if (parts[0] === 'open' && parts.length === 2) return { type: 'open', paneId: parts[1] };
  if (parts[0] === 'move' && parts.length === 2) return { type: 'move', paneId: parts[1] };
  if (parts[0] === 'move' && parts.length === 1) return bound ? { type: 'move' } : { type: 'error', message: 'Use /t move <pane_id> in the group.' };
  if (parts[0] === 'close' && parts.length === 1) return { type: bound ? 'closePicker' : 'list' };
  if (!bound && ['close', 'k', 'screen', 'ok'].includes(parts[0])) return { type: 'error', message: 'Open a topic first.' };
  if (parts[0] === 'ok' && parts.length === 1) return { type: 'ok' };
  if (parts[0] === 'close' && (parts.length === 1 || (parts.length === 2 && parts[1] === '--kill'))) return { type: 'close', kill: parts[1] === '--kill' };
  if (parts[0] === 'screen' && parts.length === 1) return { type: 'screen' };
  if (parts[0] === 'k' && validKeys(parts.slice(1))) return { type: 'keys', keys: parts.slice(1) };
  return { type: 'error', message: HELP };
}
