import { collectSystem, readTraffic, formatStatus } from './vps-health.js';

export function isUsageCommand(event) {
  return event.kind === 'message' && typeof event.text === 'string' && event.text.trim() === '/usage';
}
export function isStatusCommand(event) {
  if (event.kind !== 'message' || typeof event.text !== 'string') return false;
  const text = event.text.trim();
  return text === '/状态' || text === '/health' || (text === '状态' && (event.chatType === 'p2p' || !event.isReply));
}
export const isSystemCommand = event => isUsageCommand(event) || isStatusCommand(event);

export function isSystemOperator(event, group, registry, config) {
  if (!event.chatId || !event.openId) return false;
  if (group) return group.isOperator ? group.isOperator(event.openId) :
    (group.operatorOpenIds ?? config.operatorOpenIds ?? []).includes(event.openId);
  if (event.chatType !== 'p2p') return false;
  const operators = new Set(config.operatorOpenIds ?? []);
  for (const entry of registry.list()) {
    if (entry.isOperator?.(event.openId)) return true;
    for (const id of entry.operatorOpenIds ?? []) operators.add(id);
  }
  return operators.has(event.openId);
}

export function createStatusReader(usageReader, monitorStatus = () => null) {
  return async () => {
    const [metrics, traffic, usage] = await Promise.all([
      collectSystem().catch(() => null), readTraffic().catch(() => null),
      usageReader().catch(() => 'Claude 额度：暂不可用。'),
    ]);
    const text = formatStatus(metrics, traffic, usage), status = monitorStatus();
    return status ? `${text}\n自动提醒：内存 ${status.health === 'running' ? '运行中' : '不可用'}，额度 ${status.quota === 'running' ? '运行中' : '不可用'}。` : text;
  };
}
