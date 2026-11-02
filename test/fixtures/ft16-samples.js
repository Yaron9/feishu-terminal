import { assistantCard, userCard, outputCard, screenCard, turnCard, pickerCard } from '../../src/render.js';

export const basicCards = () => ({
  assistant: assistantCard('**修复**已完成。\n\n- 已检查消息同步。', ['🔧 Bash: 运行测试']),
  desktop: userCard('请检查卡片显示。'),
  live: screenCard({ paneId: 'pane', label: '项目 · Claude', topicId: 'topic', nonce: 'nonce', status: 'working', text: '╭────╮\n❯ \n正在检查消息同步\n✻ Worked for 2s\n╰────╯' }),
  blocked: screenCard({ paneId: 'pane', label: '项目 · Claude', topicId: 'topic', nonce: 'nonce', status: 'blocked', text: '允许执行这条命令吗？ [y/n]' }),
  shell: outputCard('$ pwd\n/home/project\n$ '),
  screen: outputCard('❯ prompt\n╰────╯', { full: true }),
});

export function allCards() {
  const turn = { agent: 'Claude', text: '正在检查项目，稍后给你结果。', tools: '🔧 Bash: 运行测试', toolCount: 1, status: 'working', settled: false };
  const props = { topicId: 'topic', nonce: 'nonce' };
  const entry = { paneId: 'w1:p1', title: '项目终端', label: '项目终端', summary: 'Claude · 空闲 · 目录 ~ · 电脑端已有 · 已绑定话题', topicDescription: '「检查项目」(07:58)', canMove: true };
  const picker = { ...props, entries: [entry] };
  const menu = '允许执行这条命令吗？\n❯ 1. 是，执行\n  2. 始终允许\n  3. 否，取消';
  return { ...basicCards(),
    turnWorking: turnCard({ ...props, turn }),
    turnBlocked: turnCard({ ...props, turn: { ...turn, status: 'blocked' }, screen: menu }),
    turnEnter: turnCard({ ...props, turn: { ...turn, status: 'blocked' }, screen: '请按 Enter 继续' }),
    turnDone: turnCard({ ...props, turn: { ...turn, text: '检查完成，测试已通过。', settled: true, status: 'idle' } }),
    turnError: turnCard({ ...props, turn: { ...turn, text: '错误：测试未通过，请检查日志。', status: 'error' } }),
    turnClipped: turnCard({ ...props, turn: { ...turn, text: '仅保留末尾的回复。', truncated: true, toolsTruncated: true } }),
    turnRecovered: turnCard({ ...props, turn, note: '📍 已从终端列表恢复' }),
    shellIdle: screenCard({ ...props, paneId: 'w1:p2', label: '项目命令行', agent: null, text: '$ ', status: 'unknown' }),
    shellRunning: screenCard({ ...props, paneId: 'w1:p2', label: '项目命令行', agent: null, text: '正在安装依赖…', status: 'working' }),
    statusIdle: screenCard({ ...props, paneId: 'w1:p1', label: '项目 · Claude', agent: 'claude', text: '等待下一条消息。', status: 'idle' }),
    statusDone: screenCard({ ...props, paneId: 'w1:p1', label: '项目 · Claude', agent: 'claude', text: '任务已完成。', status: 'done' }),
    statusError: screenCard({ ...props, paneId: 'w1:p1', label: '项目 · Claude', agent: 'claude', text: '错误：连接已断开。', status: 'error' }),
    shellClipped: outputCard(Array.from({ length: 70 }, (_, i) => `输出第 ${i + 1} 行`).join('\n')),
    pickerList: pickerCard({ ...picker, kind: 'list' }),
    pickerEmpty: pickerCard({ ...picker, kind: 'list', entries: [] }),
    pickerClose: pickerCard({ ...picker, kind: 'close' }),
    pickerConfirm: pickerCard({ ...picker, kind: 'confirm' }),
    pickerRecovered: pickerCard({ ...picker, kind: 'recovered', result: { index: 0, text: '已在话题「检查项目」(07:58)，已置顶；看不到可点 [移到新话题]' } }),
    pickerResult: pickerCard({ ...picker, kind: 'close' }, '已解绑'),
    retired: { config: { wide_screen_mode: true, update_multi: true }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '已移至下方新卡片' } }] },
  };
}
