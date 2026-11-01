import { homedir } from 'node:os';

const STATUS = { idle: '空闲', working: '工作中', blocked: '等待确认', done: '完成' };

export function paneLabel(pane, { bound = false, owned = false, home = homedir() } = {}) {
  const cwd = String(pane.foreground_cwd || pane.cwd || '');
  const normalize = value => value.replace(/\\/g, '/').replace(/\/$/, '');
  const path = normalize(cwd), base = normalize(home);
  const short = base && (path === base || path.startsWith(base + '/')) ? '~' + path.slice(base.length) : cwd;
  const title = String(pane.terminal_title_stripped || '').trim() || path.split('/').pop() || '终端';
  const agent = pane.agent ? `${pane.agent} ${STATUS[pane.agent_status] ?? '未知'}` : 'shell';
  return `${title} · ${agent} · ${short || '未知目录'} · ${owned ? '飞书创建' : '桌面'} · ${bound ? '已绑定话题' : '未绑定'} (${pane.pane_id})`;
}
