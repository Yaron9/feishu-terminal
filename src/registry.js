/**
 * @typedef {Object} Group
 * @property {string} chatId
 * @property {string} [project]
 * @property {string} [cwd]
 * @property {string} [machine]
 * @property {string[]} operatorOpenIds
 * @property {(openId: string) => boolean} [isOperator] Overrides the operator list when present.
 * @typedef {Object} GroupRegistry
 * @property {(chatId: string) => Group | null} get Synchronous lookup; null means host-owned routing.
 * @property {() => Group[]} list
 */
export function createConfigRegistry(config) {
  const ids = [...new Set([...(config.chatIds ?? []), ...Object.keys(config.groups ?? {})])];
  const entries = ids.map(chatId => ({ chatId, cwd: config.defaultCwd,
    ...config.groups?.[chatId], operatorOpenIds: config.groups?.[chatId]?.operatorOpenIds ?? config.operatorOpenIds ?? [] }));
  const groups = new Map(entries.map(entry => [entry.chatId, entry]));
  const copy = entry => {
    if (!entry) return null;
    const { isOperator, ...data } = entry;
    return { ...structuredClone(data), ...(isOperator === undefined ? {} : { isOperator }) };
  };
  return { get: chatId => copy(groups.get(chatId)), list: () => entries.map(copy) };
}
