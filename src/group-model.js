// Per-group memory of the model each CLI last used. The key is the chat id;
// once a binding names a member, that member's topics get their own key
// (`chatId:member`) so two members' choices never overwrite each other.
// Values reach a command line, so only plain model identifiers are accepted.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

const memberLabel = member => {
  if (typeof member === 'string') return member;
  if (!member || typeof member !== 'object') return null;
  return [member.key, member.id, member.openId, member.name].find(value => typeof value === 'string' && value) ?? null;
};

export function modelKey(chatId, binding = {}) {
  if (typeof chatId !== 'string' || !chatId) return null;
  const member = memberLabel(binding?.member);
  return member ? `${chatId}:${member}` : chatId;
}

export const safeModelValue = value => typeof value === 'string' && SAFE.test(value) ? value : null;

// A transcript observation becomes a storable value; unknown/unsafe fields are
// dropped instead of being echoed into a launch command.
export function cleanModel(record) {
  if (!record || typeof record !== 'object') return null;
  const model = safeModelValue(record.model);
  if (!model) return null;
  const provider = safeModelValue(record.provider), effort = safeModelValue(record.effort);
  return { ...(provider ? { provider } : {}), model, ...(effort ? { effort } : {}) };
}

export function sameModel(a, b) {
  const left = cleanModel(a), right = cleanModel(b);
  return JSON.stringify(left) === JSON.stringify(right);
}