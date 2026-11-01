# Feishu Terminal

One Feishu topic controls one herdr pane. A single Node.js process runs on the machine running herdr, using Feishu's official SDK long connection and the local herdr NDJSON socket. There is no SSH transport, tunnel requirement or public listening port. Your desktop `herdr attach` and Feishu see the same terminal.

## Run

Requires Node.js >=22, npm, and an already running herdr server (developed against 0.9.5 / protocol 22).

```sh
npm ci --omit=dev
cp config.example.json config.json
cp .env.example .env
# Edit config.json and .env on the runtime machine.
npm start
```

Configure exactly one group in `chatIds`, allowed Feishu `operatorOpenIds`, and an existing absolute Linux `defaultCwd`. Credentials come only from runtime env/`.env`: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`. `FEISHU_TERMINAL_CONFIG` selects the config file (default `./config.json`). The default socket is `~/.config/herdr/herdr.sock`; override with `HERDR_SOCKET_PATH`. Only the explicit isolated test uses `HERDR_TCP=127.0.0.1:49450`, which takes precedence over the socket path.

For persistent Linux service installation, see [deploy/README.md](deploy/README.md). Do not point an existing state file at a different herdr session: pane IDs are local to one server.

## Use

Use a dedicated Feishu **topic group** for this machine. Send text as a new top-level post to create a shell pane in the `feishu` workspace; that post becomes its topic root and its exact text is submitted as the first input. Each additional pane gets its own tab in the same workspace, without stealing desktop focus. Reply in that topic to continue. Only text message bodies are supported; files, rich-text posts and images receive a short explanation.

| Input | Behavior |
| --- | --- |
| `/t ls` | List all panes, including desktop-created panes, agent kind and status |
| `/t open w1:p2` | Create a fresh topic bound to an existing pane; already bound panes return the existing topic ID |
| `/t close` | Unbind this topic; pane keeps running |
| `/t close --kill` | Close the pane and unbind |
| `/t screen` | Refresh the live screen card (still subject to 1 Hz limit) |
| `/t k ctrl+c` | Send logical keys (allowlist, 1–8 keys); also enter, esc, tab, arrows, ctrl+u, y, n, 1–9, shift+tab, home/end, backspace/delete, pageup/pagedown |
| `/t raw some text` | Send text without Enter, preserving everything after the one separator |
| Any other text, including `/compact`, `/help`, command lines | Forward verbatim to the bound pane |

Recognized agents receive `agent.prompt`, which handles bracketed paste and refuses blocked prompts; shells receive `pane.send_text` followed by `pane.send_keys` Enter. A failed or uncertain write is never automatically retried. Replies in an unbound topic do not create new panes. Text outside a bound topic creates a pane only when it is a top-level post. Use a dedicated group: ordinary operator text there is executable input.

Each topic has one screen card, edited at most once per second, showing the last 40 visible rows, capped at 120 Unicode code points per row with explicit truncation markers. Agent `working -> idle/done` transitions and shell output quiet for about 1.5 seconds post only new `recent_unwrapped` output as normal thread messages. Long output is split at UTF-8 code point boundaries without trimming. Comparison uses content, so unchanged/zero revisions do not suppress new text. Reads retain up to 2,000 recent rows; history lost from herdr scrollback cannot be recovered. Rewritten TUI screens are a best-effort transcript; the live card is the authoritative view.

When an agent is blocked, the screen card includes Enter, Esc, 1, 2, 3, y, n, Ctrl-C and Refresh. Operator/chat ACLs, the actual card message ID, topic binding, fresh random nonce and current blocked agent state are checked before a key. Clicking consumes the nonce durably; use the refreshed card after a click. Buttons only send the key you choose; the bridge never answers an approval automatically.

Bindings, screen IDs, transcript checkpoints, button nonces and bounded dedupe history are persisted with atomic replace and fsync. Message IDs and event IDs are claimed before execution, so redelivery inside the retained 10,000-ID window cannot re-execute. This is at-most-once: a crash after claiming and before execution may lose that input. Ambiguous creation may leave an unbound pane; recover with `/t ls` and `/t open`. Only allowed operators in the allowed group can execute; other users get one short refusal per retained user/chat pair. App/bot messages are ignored.

Audit JSONL stores time, operator, topic, pane, action and byte-length/SHA-256 of input, never typed text. SDK logging is disabled to avoid leaking credentials or terminal data. Private state snapshots **do** contain terminal output for restart diffs. Terminal output deliberately goes to the allowed group. Protect its membership and the runtime state directory.

## Feishu console checklist

1. In [Feishu Developer Console](https://open.feishu.cn/app), create an **enterprise self-built application** (not a custom webhook bot), enable the **Bot** application capability, and set its available users to include your operators. Copy App ID/Secret only into the runtime env file.
2. Under **Permissions & Scopes**, request application/tenant permissions:
   - `im:message.group_msg` — read all user messages in the bot's group, required for ordinary input without @mentions. The mention-only scope `im:message.group_at_msg:readonly` cannot deliver all terminal input. [Official receive-message event and permission requirements](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive).
   - `im:message:send_as_bot` — create/reply as the bot and update its shared cards. The card PATCH endpoint accepts this as an alternative to broader `im:message` or `im:message:update`. [Official reply API](https://open.feishu.cn/document/server-docs/im-v1/message/reply), [official card PATCH API](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch).
3. In **Events & Callbacks → Event configuration**, choose **long connection** and subscribe to `im.message.receive_v1`. Start the runtime bridge when saving if the console asks for an established connection. [Official Node SDK long-connection guide](https://github.com/larksuite/node-sdk/tree/v1.76.0#long-connection).
4. In the separate **Callback configuration** tab, choose **long connection for callbacks** and add **card interaction callback** `card.action.trigger` (v2). The bridge registers it on the same SDK dispatcher and acknowledges before executing socket work. [Official card callback guide](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks).
5. Create/publish an app version, obtain tenant approval for the group-message permission, add the bot to the dedicated topic group, and put the group's `oc_...` and operators' `ou_...` IDs in config. No contact-directory lookup, user OAuth, resource/file scope or CardKit entity API is used.
6. First acceptance check with credentials: new text post creates one pane/topic; replying `/help` forwards it; shell output and one edited screen card appear in that topic; `/t k ctrl+c` sends the key. With an agent you started yourself, confirm blocked buttons work and unauthorized users cannot execute. Feishu transport/rendering and tenant approval have not been tested with real credentials.

SDK API field names (`reply_in_thread`, `uuid`, `im.message.reply`, `im.message.patch`) were checked against the pinned 1.76.0 SDK types. Its low-level WS client currently ignores `type=card` frames; `src/feishu.js` has a small pinned-version adapter that routes them through SDK dispatcher/fragmentation/ACK handling while preserving the ACK type. Synthetic SDK-frame tests cover this. Recheck the adapter when upgrading.

## Verification and layout

```sh
npm test
# Explicit opt-in ONLY against the authorized isolated ftest tunnel:
HERDR_TCP=127.0.0.1:49450 npm run test:live
```

`node --test` runs unit tests and local fake-herdr/mocked-Feishu integration tests; it never starts AI agents or connects to Feishu. The live script creates only test panes, sends `echo hello-ft1`/a brief shell sleep, verifies read/key/subscription behavior and closes its panes in a `finally` block. A down tunnel exits 2; it never falls back to the default socket. The observed shell emitted output-match events but no agent-status transitions; working/idle/blocked transitions are fixture-tested only.

`src/herdr-client.js` owns per-request NDJSON and reconnecting subscription connections; `router.js` and `render.js` are pure; `store.js` persists state/audit; `feishu.js` is the SDK edge; `bridge.js` joins them. The bridge polls each binding every second as a fallback, and re-reads when subscriptions arrive. Mutating requests are never replayed after disconnect. `config.js`, `instance-lock.js`, and `bin/feishu-terminal.js` validate config, enforce one local instance and handle shutdown. The only runtime dependency is the exact-pinned official Feishu SDK; there is no build step.
