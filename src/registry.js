/**
 * @typedef {Object} Member
 * @property {string} key Stable key; engine/model memory is keyed by `chatId:key`.
 * @property {string} [name] Display name used on the topic card.
 * @property {string[]} [aliases] Name plus nicknames accepted as a leading call.
 * @property {string} [cwd] The member's own directory.
 * @property {string} [cli] CLI key from CLI_TABLE; inherits the group's when absent.
 * @property {string} [instructionsFile] Absolute path to the member's persona file.
 * @typedef {Object} Group
 * @property {string} chatId
 * @property {string} [project]
 * @property {string} [cwd]
 * @property {string} [cli] Default CLI key from CLI_TABLE; absent preserves shell startup.
 * @property {string} [instructionsFile] Absolute path to project instructions.
 * @property {string} [machine]
 * @property {Member[]} [members] Team roster; a leading name opens that member's topic.
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
