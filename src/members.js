// A group message that starts with a team member's name or nickname opens
// that member's own topic: `易经，…`, `易经：…`, `易经 …`. The daemon's team
// dispatch rule is ported exactly — the trimmed text must START with a
// nickname; the whole text being the nickname alone means "switch only" (the
// member topic opens with no prompt, so the CLI starts and waits); otherwise
// the nickname must be followed by whitespace or punctuation, and the rest of
// the text becomes the prompt. A name in the middle of a sentence never
// matches, `@` is never used, and the first match in team order wins.

const escapeRe = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The registry's `aliases` already carries the display name plus nicknames;
// `name` stays a fallback for registries that only publish one of them.
function nicknames(member) {
  const names = [member?.name, ...(Array.isArray(member?.aliases) ? member.aliases : [])];
  const seen = new Set(), list = [];
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase()); list.push(name);
  }
  return list;
}

// Returns { member, prompt } where `prompt` is '' for a bare nickname, or
// null when the text does not start with a member's name.
export function matchMember(text, members = []) {
  const value = String(text ?? '').trim();
  if (!value || !Array.isArray(members)) return null;
  for (const member of members) {
    if (!member || typeof member !== 'object') continue;
    for (const name of nicknames(member)) {
      if (value.toLowerCase() === name.toLowerCase()) return { member, prompt: '' };
      const match = new RegExp(`^${escapeRe(name)}[\\s,，、:：]+`, 'i').exec(value);
      if (match) return { member, prompt: value.slice(match[0].length).trim() };
    }
  }
  return null;
}