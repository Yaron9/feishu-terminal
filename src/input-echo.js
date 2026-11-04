import { createHash } from 'node:crypto';
import { clean } from './render.js';

export function normalizeInput(text) {
  return clean(String(text ?? '').replace(/\r\n?/g, '\n'))
    .replace(/<\/?pasted_content\b[^>]*>/gi, '')
    .replace(/\[Pasted text #\d+(?:[^\]\r\n]*)\]/gi, '')
    .replace(/\s+/gu, ' ').trim();
}
const hash = text => createHash('sha256').update(text).digest('hex');
export const inputHash = text => hash(normalizeInput(text));

function containsInput(text, input) {
  if (!input.prefix || input.length < 32) return false;
  let offset = text.indexOf(input.prefix);
  // Compare whole normalized spans by digest, retaining only a bounded prefix
  // in state. A long paste need not be stored a second time for containment.
  while (offset >= 0 && offset + input.length <= text.length) {
    if (hash(text.slice(offset, offset + input.length)) === input.hash) return true;
    offset = text.indexOf(input.prefix, offset + 1);
  }
  return false;
}

// Exact normalized matches keep the existing delivery window. Containment is
// limited to the first user record after a delivery and a short time window;
// a short word such as "yes" cannot swallow unrelated desktop input.
export function echoIndex(item, inputs, now, terminalId, hashInput = inputHash) {
  const text = normalizeInput(item.text), timestamp = item.ts == null ? now :
    typeof item.ts === 'number' ? item.ts : Date.parse(item.ts);
  if (!text) return -1;
  const eligible = input => !input.echoChecked && (!input.terminalId || input.terminalId === terminalId) &&
    (input.sentAt == null || !Number.isFinite(timestamp) || timestamp >= input.sentAt - 1000) &&
    (input.expires == null || !Number.isFinite(timestamp) || timestamp <= input.expires);
  const hashes = [hashInput(item.text), hash(clean(item.text).trim())];
  const exact = inputs.findIndex(input => eligible(input) && hashes.includes(input.hash));
  if (exact >= 0) return exact;
  return inputs.findIndex(input => eligible(input) &&
    Number.isFinite(timestamp) && timestamp - input.sentAt <= 30000 && now >= input.sentAt && now - input.sentAt <= 30000 &&
    containsInput(text, input));
}
