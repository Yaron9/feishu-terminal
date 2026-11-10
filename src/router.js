export const KEYS = new Set([
  'enter', 'esc', 'tab', 'up', 'down', 'left', 'right', 'ctrl+c', 'ctrl+u',
  'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'shift+tab',
  'home', 'end', 'backspace', 'delete', 'pageup', 'pagedown',
]);

export function validKeys(keys) {
  return Array.isArray(keys) && keys.length >= 1 && keys.length <= 8 && keys.every(key => KEYS.has(key));
}

export const HELP = '在群里新发一条消息（如 claude 或 cd ~/proj && claude），即可新开终端；在话题内回复，会发到同一终端。\n' +
  '/状态 或 /health 查看内存、流量和额度；/usage 查看 Claude 额度。\n' +
  '/t ls 查看终端，点 [打开] 同步到话题；原话题找不到时点 [移到新话题]，也可在已绑定话题发送 /t move。\n' +
  '/t close 选择仅解绑或关闭终端；仅解绑会保留运行，关闭会结束程序。\n' +
  '/t info 查看会话标题和完整会话编号，可复制用于恢复。\n' +
  'Claude 的 /resume、/model、/config 菜单直接点选项即可选择，无需输入文字；点「更多…」翻页，Esc 取消。标有「⚠️ 已在其他终端运行」的会话需再点一次确定恢复。\n' +
  '等待确认时，数字按钮直接选择对应选项；Esc 取消，y 同意，n 拒绝，Ctrl-C 中断；[刷新] 更新画面；只有明确要求回车时才显示 Enter 继续。\n' +
  '/t screen 看完整屏幕；/t k enter 手动回车（/t k 可发 1–8 个按键）；/t raw 内容 只输入不回车；/t ok 确认已检查输入。\n' +
  '按编号操作：/t open 终端编号；/t move 终端编号；/t close --kill 直接关闭当前终端，不可恢复。';

// System status commands are intercepted by the bridge before routing. Payload whitespace is data.
export function route(text, bound = false) {
  if (typeof text !== 'string') return { type: 'error', message: '目前只支持文字消息，请发送文字或命令。' };
  if (!/^\/t(?:\s|$)/u.test(text)) {
    // /engine is an ft command in any context; it must never reach the terminal.
    // The name (if any) is validated by the bridge against the CLI table.
    if (/^\/engine(?:\s|$)/iu.test(text)) {
      const args = text.trim().split(/\s+/u).slice(1);
      return { type: 'engine', name: args.length ? args.join(' ').toLowerCase() : null };
    }
    return { type: bound ? 'input' : 'create', text };
  }
  const raw = /^\/t\s+raw(?:[ \t]|\r?\n)([\s\S]*)$/u.exec(text);
  if (raw) return bound ? { type: 'raw', text: raw[1] } : { type: 'error', message: '请先发送 /t ls，点 [打开] 进入终端话题。' };
  const parts = text.trim().split(/\s+/u).slice(1);
  // Phone smart punctuation applies only to option tokens in this grammar.
  // Raw payloads and ordinary terminal input have already returned verbatim.
  if (parts[0] === 'close' && parts.length > 1) parts[1] = parts[1].replace(/^[—–](?=[a-z])/iu, '--');
  if (parts[0] === 'ls' && parts.length === 1) return { type: 'list' };
  if (parts[0] === 'open' && parts.length === 2) return { type: 'open', paneId: parts[1] };
  if (parts[0] === 'move' && parts.length === 2) return { type: 'move', paneId: parts[1] };
  if (parts[0] === 'move' && parts.length === 1) return bound ? { type: 'move' } : { type: 'error', message: '请发送 /t ls，点 [移到新话题]；或在群里发送 /t move 终端编号。' };
  if (parts[0] === 'close' && parts.length === 1) return { type: bound ? 'closePicker' : 'list' };
  if (!bound && ['close', 'k', 'screen', 'ok', 'info'].includes(parts[0])) return { type: 'error', message: '请先发送 /t ls，点 [打开] 进入终端话题。' };
  if (parts[0] === 'info' && parts.length === 1) return { type: 'info' };
  if (parts[0] === 'ok' && parts.length === 1) return { type: 'ok' };
  if (parts[0] === 'close' && (parts.length === 1 || (parts.length === 2 && parts[1] === '--kill'))) return { type: 'close', kill: parts[1] === '--kill' };
  if (parts[0] === 'screen' && parts.length === 1) return { type: 'screen' };
  if (parts[0] === 'k' && validKeys(parts.slice(1))) return { type: 'keys', keys: parts.slice(1) };
  return { type: 'error', message: HELP };
}
