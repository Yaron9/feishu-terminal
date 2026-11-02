import { homedir } from 'node:os';

const STATUS = { idle: '空闲', working: '工作中', blocked: '等待你确认', done: '已完成' };

export function paneDetails(pane, { bound = false, frozen = false, owned = false, home = homedir() } = {}) {
  const cwd = String(pane.foreground_cwd || pane.cwd || '');
  const normalize = value => value.replace(/\\/g, '/').replace(/\/$/, '');
  const path = normalize(cwd), base = normalize(home);
  const short = base && (path === base || path.startsWith(base + '/')) ? '~' + path.slice(base.length) : cwd;
  const title = String(pane.terminal_title_stripped || '').trim() || path.split('/').pop() || '终端';
  const agent = pane.agent ? `${/^claude$/i.test(pane.agent) ? 'Claude' : /^codex$/i.test(pane.agent) ? 'Codex' : pane.agent} · ${STATUS[pane.agent_status] ?? '状态待更新'}` : '命令行';
  const summary = `${agent} · 目录 ${short || '未提供'} · ${owned ? '从飞书新开' : '电脑端已有'} · ${frozen ? '已暂停同步（点打开重新绑定）' : bound ? '已绑定话题' : '未绑定'}`;
  return { title, summary };
}

export function paneLabel(pane, options) {
  const { title, summary } = paneDetails(pane, options);
  return `${title} · ${summary}`;
}
