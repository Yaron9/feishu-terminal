import { randomUUID, createHash } from 'node:crypto';
import { clean, userCard } from './render.js';
import { echoIndex } from './input-echo.js';

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
export function turnChunks(items, previous, source, agent, status, inputs, inputHash, { now = Date.now(), terminalId } = {}) {
  let turn = previous && structuredClone(previous), dirty = false;
  const chunks = [], consumedInputs = [], checkedInputs = [];
  const save = () => {
    if (dirty) chunks.push({ turn: structuredClone(turn) });
    dirty = false;
  };
  const finish = () => {
    if (turn && !turn.settled) { turn.settled = true; turn.status = 'idle'; dirty = true; }
    save();
  };
  for (const item of items) {
    if (item.role === 'turn_end') { finish(); continue; }
    if (item.role === 'user') {
      finish();
      const index = echoIndex(item, inputs, now, terminalId, inputHash);
      if (index !== -1) consumedInputs.push(inputs.splice(index, 1)[0].id);
      else {
        chunks.push({ card: userCard(item.text), uuid: randomUUID() });
        const timestamp = item.ts == null ? now : typeof item.ts === 'number' ? item.ts : Date.parse(item.ts);
        for (const input of inputs) if (input.sentAt == null || !Number.isFinite(timestamp) || timestamp >= input.sentAt - 1000) {
          input.echoChecked = true; checkedInputs.push(input.id);
        }
      }
      turn = freshTurn(source, agent, status); turn.userPrompt = true; dirty = true;
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
    turn.status = turn.settled ? 'idle' : status === 'blocked' ? 'blocked' : 'working';
    // Do not call a just-observed user input complete on a stale idle sample.
    if (!source.adapter?.transcriptTurns && turn.hasOutput && ['idle', 'done'].includes(status)) { turn.status = 'idle'; turn.settled = true; }
  }
  save();
  return { chunks, consumedInputs, checkedInputs };
}

