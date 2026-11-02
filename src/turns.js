import { randomUUID, createHash } from 'node:crypto';
import { clean, userCard } from './render.js';

const bounded = text => Array.from(clean(text)).slice(-1500).join('');
export const turnSignature = turn => createHash('sha256').update(JSON.stringify(turn)).digest('hex');
export const freshTurn = (source, agent, status = 'working') => ({
  id: randomUUID(), adapter: source.key, path: source.path, agent,
  text: '', tools: '', toolCount: 0, truncated: false, toolsTruncated: false,
  status: status === 'blocked' ? 'blocked' : 'working', settled: false,
  activeObserved: ['working', 'blocked'].includes(status),
});

// Fixed, bounded snapshots become durable output operations before any send.
// A user always starts a turn, including a matched (non-echoed) Feishu input.
export function turnChunks(items, previous, source, agent, status, inputs, inputHash) {
  let turn = previous && structuredClone(previous), dirty = false;
  const chunks = [], consumedInputs = [];
  const save = () => {
    if (dirty) chunks.push({ turn: structuredClone(turn) });
    dirty = false;
  };
  const finish = () => {
    if (turn && !turn.settled) { turn.settled = true; turn.status = 'idle'; dirty = true; }
    save();
  };
  for (const item of items) {
    if (item.role === 'user') {
      finish();
      const index = inputs.findIndex(input => input.hash === inputHash(item.text));
      if (index !== -1) consumedInputs.push(inputs.splice(index, 1)[0].id);
      else chunks.push({ card: userCard(item.text), uuid: randomUUID() });
      turn = freshTurn(source, agent, status); dirty = true;
    } else if (['assistant', 'tool'].includes(item.role)) {
      if (!turn || turn.settled || turn.path !== source.path || turn.adapter !== source.key) {
        finish(); turn = freshTurn(source, agent, status);
      }
      if (item.role === 'assistant') {
        const text = turn.text + (turn.text ? '\n\n' : '') + clean(item.text);
        turn.truncated ||= Array.from(text).length > 1500;
        turn.text = bounded(text);
      } else {
        const tools = turn.tools + (turn.tools ? '\n' : '') + Array.from(clean(item.text).replace(/\s+/g, ' ')).slice(0, 140).join('');
        turn.toolsTruncated ||= Array.from(tools).length > 1500;
        turn.tools = bounded(tools); turn.toolCount++;
      }
      turn.hasOutput = true; dirty = true;
    }
  }
  if (dirty) {
    turn.status = status === 'blocked' ? 'blocked' : 'working';
    // Do not call a just-observed user input complete on a stale idle sample.
    if (turn.hasOutput && ['idle', 'done'].includes(status)) { turn.status = 'idle'; turn.settled = true; }
  }
  save();
  return { chunks, consumedInputs };
}

