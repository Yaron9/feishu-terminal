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

## 一次扫码安装

在运行 herdr 的 Linux 主机上执行（Node.js >=22）。首次安装不需要已有应用凭据，也不需要手动填写群 ID：

```sh
bash deploy/install.sh
export PATH="$HOME/.local/bin:$PATH"
export FEISHU_TERMINAL_CONFIG="$HOME/.config/feishu-terminal/config.json"
feishu-terminal setup
# 手机飞书打开 SETUP_URL 所示的完整链接，确认创建应用。
# 等待 SETUP OK 后再继续：
systemctl --user daemon-reload
systemctl --user enable --now feishu-terminal
# 显式指定隔离的 ftest herdr socket；替换为指挥者提供的实际路径：
feishu-terminal selftest --herdr-socket /absolute/path/to/ftest.sock
```

`setup` 使用锁定的官方 SDK 1.76.0 `registerApp`，只创建新应用，预填“VPS 终端”，默认智能体模板另加 `im:message.group_msg`。手机上需要用户确认；企业策略可能要求管理员审批。stdout 仅输出 `SETUP_URL <url>` 与 `SETUP_EXPIRES <UTC时间>`，有效期遵从 SDK；其他进度、权限表与错误均输出到 stderr。链接与有效期保存在 `${STATE:-$HOME/.local/state/feishu-terminal}/setup-url.txt`（0600）。可选二维码工具：在另一终端执行 `sed -n 's/^SETUP_URL //p' "${STATE:-$HOME/.local/state/feishu-terminal}/setup-url.txt" | qrencode -t ansiutf8`，无需安装 Node 二维码库。

确认后自动合并 `~/.config/feishu-terminal/.env` 的应用凭据，先生成 `.env.bak-<timestamp>`；保留其他行。凭据、备份、配置均为 0600，不打印 secret。创建以话题形式显示消息的普通群（`group_message_type: "thread"`），让扫码用户成为群主和唯一授权操作者，发送中文使用说明，检查权限；它与客户端独立的“话题群”模式不同。已有真实 `chatIds` 时保留群；新应用必须已经在这个群里，否则使用 `feishu-terminal setup --new-group` 创建新群。每次重跑都是新的注册，不支持续接；重配前先停止服务，旧绑定状态需要按实际 herdr/群归属人工保留或迁移，setup 不删除历史状态。

`im:message.group_msg` 尚未授权时会明确提示；审批完成前可在群里先 @机器人再写命令。仅移除开头对当前机器人的提及标记，其他内容保持原样。拒绝或过期退出 2，其他失败退出 1，完成退出 0。注册成功后若建群/欢迎消息/权限检查失败，已保存的凭据和群配置保留，错误不会回显服务端敏感内容。Lark 租户会明确失败，当前桥接只面向飞书。

安装后的命令自动加载配置旁的 `.env`，系统环境变量优先。`FEISHU_TERMINAL_CONFIG` 可显式选择配置；否则优先当前目录已有的 `config.json`，再用安装目录。`STATE` 仅选择 setup 链接和 selftest 临时状态目录；桥接的状态路径由配置决定。安装器创建 `~/.local/bin/feishu-terminal`，不会启动服务。

`selftest` 是显式的真实写入测试：使用已配置的应用和群，通过真实 Bridge、真实 Feishu API 和显式 herdr endpoint，注入与 SDK 相同结构的消息及卡片事件，逐项输出 PASS/FAIL。测试话题/输出标注 `[selftest]`；验证 echo 输出回读、卡片 PATCH 后回读、`/t screen`、Refresh 回调、Ctrl-C 实际中断、`/t close` 解除绑定与 `/t close --kill` 关闭自建 pane，失败也只清理本次拥有的 pane。用独立临时状态，不改运行服务的绑定；测试群消息保留供检查。也可显式使用 `HERDR_TCP=127.0.0.1:49450 feishu-terminal selftest`。不指定 endpoint 会失败，不会自动使用默认 socket。

WS 检查读取 SDK `getConnectionStatus().state`，短暂连接后关闭，测试期间不处理真实入站消息；同一应用的 WS 连接可能分摊事件，请在没有用户输入时测试。此测试不证明真实消息/按钮事件已由飞书投递；最后仍需从手机发一个话题并检查真实按钮。若卡片回读缺少更新内容，selftest 会失败，不能把 API 请求成功当成完整通过。源码机器的无凭据测试不执行真实注册或 Feishu 调用。

## Use

Use a dedicated Feishu **topic group** for this machine. Send text as a new top-level post to create a shell pane in the `feishu` workspace; that post becomes its topic root and its exact text is submitted as the first input. Each additional pane gets its own tab in the same workspace, without stealing desktop focus. Reply in that topic to continue. Only text message bodies are supported; files, rich-text posts and images receive a short explanation.

| Input | Behavior |
| --- | --- |
| `/t ls` | List all panes, including desktop-created panes, agent kind and status |
| `/t open w1:p2` | Bind a pane in workspace `feishu` to a fresh topic; explicitly reverify a frozen binding in its existing topic |
| `/t close` | Unbind this topic; pane keeps running |
| `/t close --kill` | Close the pane and unbind |
| `/t screen` | Refresh the live screen card (still subject to 1 Hz limit) |
| `/t ok` | Confirm that you inspected an uncertain input result and enable input again |
| `/t k ctrl+c` | Send logical keys (allowlist, 1–8 keys); also enter, esc, tab, arrows, ctrl+u, y, n, 1–9, shift+tab, home/end, backspace/delete, pageup/pagedown |
| `/t raw some text` | Send text without Enter, preserving everything after the one separator |
| Any other text, including `/compact`, `/help`, command lines | Forward verbatim to the bound pane |

Recognized agents receive `agent.prompt`, which handles bracketed paste and refuses blocked prompts; shells receive `pane.send_text` followed by `pane.send_keys` Enter. A failed or uncertain write is never automatically retried. Before shell writes the bridge persists `needs_check`; it clears that flag only after success. If the result is uncertain, the bridge posts the screen and refuses ordinary input, raw text and other keys until you inspect it and send `/t ok`. You can first clear the input line with `/t k ctrl+u`; clearing alone does not acknowledge the screen. This protection survives restart. Replies in an unbound topic do not create new panes. Text outside a bound topic creates a pane only when it is a top-level post. Use a dedicated group: ordinary operator text there is executable input.

Bindings persist herdr's `terminal_id`, workspace ID and tab ID. On startup, every subscription reconnect and before writing, the bridge confirms the terminal identity, its recorded tab and the workspace label `feishu`. A missing identity, changed terminal/tab/workspace, or failed verification freezes the binding. Legacy bindings without identity also freeze. Use `/t open <pane_id>` to explicitly rebind after inspecting `/t ls`, or `/t close` to unbind. `/t ok` does not clear an identity freeze; `--kill` also requires verified identity.

Each topic has one screen card, edited at most once per second, showing the last 40 visible rows, capped at 120 Unicode code points per row with explicit truncation markers. Agent `working -> idle/done` transitions and shell output quiet for about 1.5 seconds post only new `recent_unwrapped` output as normal thread messages. An idle/done agent first seen after restart, reconnect or a missed working event also flushes changed output after that stable window; working/blocked/unknown agents keep waiting. Diff and chunk boundaries use Unicode code points. Comparison uses content, so unchanged/zero revisions do not suppress new text. Reads retain up to 2,000 recent rows; history lost from herdr scrollback cannot be recovered. Rewritten TUI screens are a best-effort transcript; the live card is the authoritative view.

Before sending text the bridge persists a fixed batch of chunks and UUIDs, then saves each successful chunk's progress. A restart resumes that batch before taking newer output. UUIDs are 36 characters and ambiguous retries stop after 55 minutes, inside Feishu's [one-hour deduplication window](https://open.feishu.cn/document/server-docs/im-v1/message/reply). An expired uncertain batch remains paused in state: inspect delivery before deciding to unbind/reopen, which discards the pending batch. Card failures do not suppress transcript flushes. Recalled, deleted or expired cards are replaced with a new message; temporary errors back off up to 30 seconds. Card publication persists a pending version first and commits its card ID and nonce together only after success. Pending versions are retried on restart; consumed nonces never become valid again.

When an agent is blocked, the screen card includes Enter, Esc, 1, 2, 3, y, n, Ctrl-C and Refresh. Operator/chat ACLs, the actual card message ID, topic binding, fresh random nonce and current blocked agent state are checked before a key. Clicking consumes the nonce durably; use the refreshed card after a click. Buttons only send the key you choose; the bridge never answers an approval automatically.

Bindings, screen IDs, transcript checkpoints, button nonces and bounded dedupe history are persisted with atomic replace and fsync. Input delivery is **at most once** within the retained 10,000-ID history. The SDK callback waits for an atomic, fsynced local dedupe claim before acknowledging; it does not wait for terminal or Feishu API requests. A failed claim requests redelivery. A crash after the claim can lose queued input, which is never replayed automatically. There is no durable inbox. Inputs run in order per topic; output/card work uses separate per-topic queues and cannot hold up another topic's terminal input. Ambiguous creation may leave an unbound pane; recover with `/t ls` and `/t open`. Only allowed operators in the allowed group can execute; other users get one short refusal per retained user/chat pair. App/bot messages are ignored.

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

