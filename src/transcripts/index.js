import { ClaudeTranscript } from './claude.js';
import { CodexTranscript } from './codex.js';
import { PiTranscript } from './pi.js';

export function transcriptAdapters(options) {
  return { claude: new ClaudeTranscript(options), codex: new CodexTranscript(options), pi: new PiTranscript(options) };
}
