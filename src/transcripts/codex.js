// TODO: resolve Codex rollouts from the owning PID's open fds, with a verified
// session/cwd mapping. Newest-cwd alone can attach another pane's conversation.
// Until that mapping can be tested, use the bounded, stripped screen fallback.
export class CodexTranscript {
  async locate() { return null; }
}
