/**
 * @typedef {Object} Group
 * @property {string} chatId
 * @property {string} [project]
 * @property {string} [cwd]
 * @property {string} [machine]
 * @property {string[]} operatorOpenIds
 * @typedef {Object} GroupRegistry
 * @property {(chatId: string) => Group | null} get Synchronous lookup; null means host-owned routing.
 * @property {() => Group[]} list
 */
export function createConfigRegistry(config) {
  const ids = [...new Set([...(config.chatIds ?? []), ...Object.keys(config.groups ?? {})])];
  const entries = ids.map(chatId => ({ chatId, cwd: config.defaultCwd,
    ...config.groups?.[chatId], operatorOpenIds: config.groups?.[chatId]?.operatorOpenIds ?? config.operatorOpenIds ?? [] }));
  const groups = new Map(entries.map(entry => [entry.chatId, entry]));
  return { get: chatId => structuredClone(groups.get(chatId) ?? null), list: () => structuredClone(entries) };
}
