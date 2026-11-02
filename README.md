# Feishu Terminal

One Feishu topic controls one terminal. A single Node.js process runs on the terminal host, using Feishu's official SDK long connection and local herdr-core / legacy herdr sockets. There is no public listening port. Herdr desktop (via `hc connect`) and Feishu control the same herdr-core terminals.

## Run

Requires Node.js >=22, npm, and an already running herdr-core daemon (developed against 0.1.16 / protocol generation 1). Legacy herdr 0.9.5 / protocol 22 remains supported during migration.

```sh
npm ci --omit=dev
mkdir -p "$HOME/.config/feishu-terminal"
cp config.example.json "$HOME/.config/feishu-terminal/config.json"
cp .env.example "$HOME/.config/feishu-terminal/.env"
# Edit the installed config and its sibling .env on the runtime machine.
npm start
```

Configure exactly one group in `chatIds`, allowed Feishu `operatorOpenIds`, and an existing absolute Linux `defaultCwd`. Credentials come only from runtime env/the config's sibling `.env`: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`. The default config is always `~/.config/feishu-terminal/config.json`; `FEISHU_TERMINAL_CONFIG` overrides it. Relative state/audit paths resolve from the config directory. The default socket is `~/.config/herdr/herdr.sock`; override with `HERDR_SOCKET_PATH`. Only the explicit isolated test uses `HERDR_TCP=127.0.0.1:49450`, which takes precedence over the socket path.

For persistent Linux service installation, see [deploy/README.md](deploy/README.md). Do not point an existing state file at a different herdr session: pane IDs are local to one server.

## 迁移到 herdr-core

在 VPS 同一用户下运行 `herdr-core serve`。已有 hc 的机器无需重装；Herdr 桌面通过 SSH 的 `hc connect` 连接该 VPS。飞书桥接在 VPS 本机直接连接 socket，不需要额外 SSH 子进程。

配置默认启用两个后端，新话题使用 herdr-core：

```json
{
  "backends": ["hc", "herdr"],
  "newTerminalBackend": "hc",
  "sessionFollow": "newest"
}
```

1. 更新代码后重启飞书桥接服务，保留现有 `stateFile`。旧 herdr 的 `w1:p2` 等编号和绑定不需迁移；hc 编号为 `hc:t1`，远程机器为 `hc:mac/t3`。`/t ls` 显示「herdr-core」和「旧 herdr」。一个后端不可用时，另一个仍可使用。
2. 在 Herdr 桌面打开 VPS 上的 hc 终端，执行 `claude --resume <sessionId>`（使用原会话的目录）。也可在飞书群顶层发送这条命令，新终端默认创建在 hc；若该会话已有绑定，继续使用原话题，避免生成第二个绑定。
3. 桥接每秒扫描会话进程。原话题自动跟随启动时间最新的 Claude，保留话题、读取位置和轮次卡片；先保存新绑定，再重新核实旧进程的 Claude 名称、会话 ID 和启动时间，然后发送 SIGTERM。最多等待 10 秒，不发送 SIGKILL；仍存活或无法核实的 PID 会显示在话题中。菜单和旧卡片按钮重新校验后才能操作。
4. 全部话题转移后，设置 `"backends": ["hc"]`，重启桥接，再按需移除旧 herdr。若新进程只在普通 SSH 中，桥接只警告、不终止任何进程。目标已绑定另一个话题时不抢占。`"sessionFollow": "warn"` 可恢复只警告的行为。

hc 默认 socket 是 `${XDG_RUNTIME_DIR:-/run/user/<uid>}/herdr-core/default.sock`，本次 VPS 为 `/run/user/1000/herdr-core/default.sock`。可用 `HC_SOCKET_PATH` 或 hc 自身的 `HC_TERMINAL_SOCKET` 指定（后者优先）。桥接必须与 Claude 同用户运行，能够读取本机 `/proc` 和 `~/.claude/sessions/<pid>.json`；不读取 `.key` 文件。远程 hc 编号可控制，但自动会话跟随仅检查本机进程。

所有 hc 屏幕读取都用 `terminal.read` 的 `lines: 0`；历史和后台任务通过 Claude JSONL 读取，避免滚动或改变程序尺寸。hc 的 send/keys 会等待人停止输入约 3 秒，桥接为写操作保留 60 秒窗口。`started: false/null` 不代表输入失败；只有一次发送，断线或超时后先检查屏幕并 `/t ok`，不会重发。`/t raw` 用短暂 framed attach 发送带括号粘贴的文字，不追加 Enter；其确认只表示 core 已处理输入帧，不保证程序已执行。

后端接口见 [src/backends](src/backends)：`list/get/read/sendText/sendKeys/close/create/subscribe`，以及 `identity/processOf/status`；桥接、菜单、轮次和话题使用同一接口。

## 一次扫码安装

在运行 herdr 的 Linux 主机上执行（Node.js >=22）。首次安装不需要已有应用凭据，也不需要手动填写群 ID：

```sh
bash deploy/install.sh
export PATH="$HOME/.local/bin:$PATH"
feishu-terminal setup
# 手机飞书打开 SETUP_URL 所示的完整链接，确认创建应用。
# 中断或失败后直接重跑 setup，续接同一应用；不要加 --new-app。
# 若出现 SETUP_JOIN_URL：打开链接入群，在 15 分钟内发一条 @机器人 消息认领。
# 若退出 3 / missing_operator 或 claim_expired：feishu-terminal setup --operator ou_xxx
# 等待 SETUP OK 后再继续：
# 在配置旁 .env 设置生产 HERDR_SOCKET_PATH；清除隔离测试用的 HERDR_TCP。
systemctl --user daemon-reload
systemctl --user enable --now feishu-terminal
journalctl --user -u feishu-terminal -n 20
# 确认 herdr ok <生产端点>；herdr_unreachable 时服务保持运行并重试 ping。
# 显式指定隔离的 ftest herdr socket；替换为指挥者提供的实际路径：
feishu-terminal selftest --herdr-socket /absolute/path/to/ftest.sock
```

`setup` 优先读取配置旁 `.env` 的已有应用并获取 token 验证；仅在没有已保存应用、已有应用获取 token 失败，或显式传入 `--new-app` 时注册新应用。注册使用锁定的官方 SDK 1.76.0 `registerApp`，预填“VPS 终端”，默认智能体模板另加 `im:message.group_msg` 与 `im:chat:readonly`（群成员验证必需）。手机上需要用户确认；企业策略可能要求管理员审批。注册时 stdout 输出 `SETUP_URL <url>` 与 `SETUP_EXPIRES <UTC时间>`，有效期遵从 SDK；缺失操作者时还会输出 `SETUP_JOIN_URL <url>`。其他进度、权限表与错误均输出到 stderr；setup 和 selftest 都在 stderr 输出 `CONFIG <绝对路径>`。注册链接与有效期保存在 `${STATE:-$HOME/.local/state/feishu-terminal}/setup-url.txt`（0600）。可选二维码工具：在另一终端执行 `sed -n 's/^SETUP_URL //p' "${STATE:-$HOME/.local/state/feishu-terminal}/setup-url.txt" | qrencode -t ansiutf8`，无需安装 Node 二维码库。

确认后先自动合并 `~/.config/feishu-terminal/.env` 的应用凭据，生成 `.env.bak-<timestamp>` 并保留其他行。`${STATE:-$HOME/.local/state/feishu-terminal}/setup-progress.json` 原子保存 `registered`（仅 app_id）、`group_created`（chat_id）、`configured`、`welcomed`、`scopes_checked` 阶段；凭据仅在 `.env`，进度不含 secret。凭据、备份、进度、配置均为 0600。失败后直接重跑 `feishu-terminal setup`，从第一个未完成阶段续接同一应用，不会重复已完成的欢迎消息和权限检查。

创建以话题形式显示消息的普通群（`group_message_type: "thread"`），通常让扫码用户成为群主和唯一授权操作者，发送中文使用说明，检查权限；它与客户端独立的“话题群”模式不同。保留已保存群前，通过当前应用的 tenant token 验证机器人确实在群里；不在则另建群。建群前分页查找名为“VPS 终端”的群，以恢复建群响应丢失的情况；同名群只有同时满足机器人在群、消息模式为 thread、操作者在群才可复用。没有合格候选则新建；多个合格候选时停止，先在配置中指定正确群再续接。`--new-group` 为同一应用另建群，失败后仍续接该次操作。重配前先停止服务；旧绑定状态需要按实际 herdr/群归属人工保留或迁移，setup 不删除历史状态。

`im:message.group_msg` 尚未授权时会明确提示；全群消息权限审批完成前，每条消息（包括新话题和话题内回复）都必须 @机器人。机器人自己的提及实体可位于开头、中间或结尾，仅合并移除处的水平空白；其他提及和其余空白保持原样。

注册没有返回 `user_info.open_id` 且未传 `--operator` 时，先保存凭据，再创建仅有机器人的新群。setup 使用 `im:chat:readonly` 取得入群链接，启动临时 WebSocket 认领连接，只接收本新群的用户消息；第一位非机器人用户通过事件送达的 open_id 先持久化，再在群内确认。全群消息待批时，入群后须发一条 @机器人 消息，使用预置的 `im:message.group_at_msg:readonly`；不依赖需要全群消息授权的历史消息查询。该发言仅用于认领，不执行终端命令。认领截止时间为建群后 15 分钟，重跑不延长；超时退出 3 / `claim_expired`。认领确认丢失时用原 UUID 续接。根据[官方获取群分享链接接口](https://open.feishu.cn/document/server-docs/group/chat/link.md)，请求方法为 POST，权限无需额外增加。只把入群链接交给预期操作者。

拒绝或注册过期退出 2；操作者 open_id 无效退出 3 / `missing_operator`；可用 `feishu-terminal setup --operator ou_xxx` 指定同一应用下的操作者续接已保存应用和群。其他失败退出 1，完成退出 0。未见 `SETUP OK` 不要启动服务。API 阶段失败只保留数字 HTTP 状态与飞书错误码，不回显服务端消息或敏感内容。Lark 租户会明确失败，当前桥接只面向飞书。

CLI、`npm start` 和 systemd 都通过同一解析器默认选择 `~/.config/feishu-terminal/config.json`，自动加载配置旁的 `.env`，系统环境变量优先；当前目录的 `config.json` 不参与选择。`FEISHU_TERMINAL_CONFIG` 可显式选择另一份配置；服务也须通过 systemd override 设置同一绝对路径。setup 会把示例 cwd 和 `./state/...` 占位路径替换为用户 home 和状态目录的绝对路径，保留真实自定义值；服务拒绝不存在或非目录的 cwd。`STATE` 选择 setup 链接、setup 进度和 selftest 临时状态目录；桥接的状态路径由配置决定。安装器创建 `~/.local/bin/feishu-terminal`，不会启动服务。

`selftest` 是显式的真实写入测试：使用已配置的应用和群，通过真实 Bridge、真实 Feishu API 和显式 herdr endpoint，注入与 SDK 相同结构的消息及卡片事件，逐项输出 PASS/FAIL。它打印本次测试端点并提醒其可能与服务端点不同；`--herdr-socket` 不改变服务配置。测试话题/输出标注 `[selftest]`；验证 echo 输出回读、卡片 PATCH 后回读、`/t screen`、Refresh 回调、Ctrl-C 实际中断、`/t close` 解除绑定与 `/t close --kill` 关闭自建 pane，失败也只清理本次拥有的 pane。用独立临时状态，不改运行服务的绑定；测试群消息保留供检查。也可显式使用 `HERDR_TCP=127.0.0.1:49450 feishu-terminal selftest`。不指定 endpoint 会失败，不会自动使用默认 socket。

WS 检查读取 SDK `getConnectionStatus().state`，短暂连接后关闭，测试期间不处理真实入站消息；同一应用的 WS 连接可能分摊事件，请在没有用户输入时测试。此测试不证明真实消息/按钮事件已由飞书投递；最后从手机实际发 `@机器人 pwd` 新话题，再在同一话题发 `@机器人 echo hello`，核对同一 pane 并检查真实按钮；审批后再验证不 @ 的消息。若卡片回读缺少更新内容，selftest 会失败，不能把 API 请求成功当成完整通过。源码机器的无凭据测试不执行真实注册或 Feishu 调用。

## Use

Use a dedicated Feishu **topic group** for this machine. Send text as a new top-level post to create a shell pane in the `feishu` workspace; that post becomes its topic root and its exact text is submitted as the first input. Each additional pane gets its own tab in the same workspace, without stealing desktop focus. Reply in that topic to continue. Only text message bodies are supported; files, rich-text posts and images receive a short explanation.

| Input | Behavior |
| --- | --- |
| `/t ls` | Show a terminal picker with 打开 / 关闭 and, for panes bound in this chat, 移到新话题; bound rows include the root text and UTC+8 creation time |
| `/t open w1:p2` | Bind an unbound pane in workspace `feishu` to a fresh topic; recover an existing topic with a fresh screen reply; explicitly reverify a frozen binding |
| `/t move` / `/t move w1:p2` | Move the current bound pane, or the named bound pane, to a new top-level topic with a fresh status card; keep its transcript cursor |
| `/t close` | In a bound topic, offer 仅解绑 / 关闭终端 / 取消; at top level, show the terminal picker |
| `/t close --kill` | Close the pane and unbind |
| `/t screen` | Refresh live status (1 Hz limit) and reply with the full current viewport in bounded screen cards |
| `/t ok` | Confirm that you inspected an uncertain input result and enable input again |
| `/t k ctrl+c` | Send logical keys (allowlist, 1–8 keys); also enter, esc, tab, arrows, ctrl+u, y, n, 1–9, shift+tab, home/end, backspace/delete, pageup/pagedown |
| `/t raw some text` | Send text without Enter, preserving everything after the one separator |
| Any other text, including `/compact`, `/help`, command lines | Forward verbatim to the bound pane |

手机操作：发送 `/t ls`，按摘要选择「打开」，未绑定的终端会新建并绑定一个话题，同时显示屏幕卡片；已有绑定则在原话题新发屏幕卡片，附注「📍 已从终端列表恢复」，让话题回到列表顶部，旧卡片显示「已移至下方新卡片」并移除按钮。请回到话题列表进入；不生成未经官方文档支持的消息链接。顶层 `/t open <pane>` 同样恢复原话题；在其他话题中调用会提示原话题已置顶，不会改变当前话题的绑定。摘要依次显示标题（缺省为目录名）、智能体及中文状态（空闲 / 工作中 / 等待你确认 / 已完成，普通终端为命令行）、当前目录（主目录缩为 `~`）、来源（从飞书新开 / 电脑端已有）、绑定状态，最后用灰色小字显示终端编号。点击「关闭」或在绑定话题发送 `/t close`，再选「仅解绑」（保留会话）、「关闭终端」或「取消」。桌面终端以及工作中、等待确认的智能体还会出现「确定关闭」确认，会话将结束。显式 `/t close --kill` 仍直接关闭，不弹卡片。手机把选项开头的 `--` 自动替换为 `—` 或 `–` 时，`/t close —kill`、`/t close –kill` 也能识别；普通终端文本与 `/t raw` 内容保持原样。

已绑定行另显示原话题正文（约 30 字）和 UTC+8 创建时间。「打开」恢复后，该行显示 `已在话题「…」(HH:MM)，已置顶；看不到可点 [移到新话题]`，并保留使用新 nonce 的「移到新话题」按钮。飞书的「删除话题」可能只对本人隐藏，API 无法判断；此时直接点「移到新话题」，或在绑定话题发送 `/t move`、在群顶层发送 `/t move <pane>`。新话题以 `终端：<摘要>` 开头，原话题尽力发送迁移提示，选择行显示 `已移到新话题，在列表最上面`。

每张选择卡片的 nonce 只能使用一次；进入关闭确认或恢复后的迁移按钮时换发新的随机 nonce。卡片和 nonce 持久保存，重启不会恢复已用按钮。卡片 10 分钟过期，每次点击都检查群、操作者、卡片 ID、话题、nonce 和终端真实身份；终端已变化时显示 `终端已变化，请重新 /t ls`，不会关闭不在当前列表中的终端。此前版本创建的终端缺少来源记录，保守显示「电脑端已有」并要求二次确认。

Recognized agents receive `agent.prompt`, which handles bracketed paste and refuses blocked prompts; shells receive `pane.send_text` followed by `pane.send_keys` Enter. A failed or uncertain write is never automatically retried. Before shell writes the bridge persists `needs_check`; it clears that flag only after success. If the result is uncertain, the bridge posts the screen and refuses ordinary input, raw text and other keys until you inspect it and send `/t ok`. You can first clear the input line with `/t k ctrl+u`; clearing alone does not acknowledge the screen. This protection survives restart. Replies in an unbound topic do not create new panes. Text outside a bound topic creates a pane only when it is a top-level post. Use a dedicated group: ordinary operator text there is executable input.

Bindings persist herdr's `terminal_id`, workspace ID and tab ID. On startup, every subscription reconnect, before writing, before and after output reads, and before publication, the bridge confirms the terminal identity, its recorded tab and workspace. Text `/t open` retains its `feishu` workspace restriction; the picker can also bind desktop panes in other existing workspaces, explicitly recording that permission and still checking their exact terminal/tab/workspace IDs. A missing identity, changed terminal/tab/workspace, or failed verification freezes the binding, removes its subscription and discards pending cards and output. Frozen bindings cannot read or publish until explicit rebind. Legacy bindings without identity also freeze. Inspect `/t ls` before explicitly rebinding with `/t open <pane_id>`; a close card also refuses a changed identity. `/t ok` does not clear an identity freeze; `--kill` also requires verified identity.

Shell and fallback topics have one compact live status card, edited at most once per second: `● · 工作中 / 空闲 / 等待你确认（命令行使用灰色「命令行 · 空闲/运行中」）`, the pane label, and at most ten nonempty preview lines (120 Unicode code points per line). Frames, empty prompts, spinners and status chrome are stripped. `/t screen` separately shows the full current viewport, including its chrome, split into small screen cards when necessary.

Claude conversations use a read-only local JSONL adapter. It matches the newest `claude` process with the exact `HERDR_PANE_ID` in `/proc`, reads only `sessionId`, `cwd` and `pid` from `~/.claude/sessions/<pid>.json`, and verifies the escaped project directory and transcript file. It never opens session `*.key` files. Each observed user input starts one turn card; the first assistant/tool item after a settled turn also starts a new card. During that turn the same card is patched at most once every two seconds, including retries and after restart. Its blue header is `🤖 Claude · 工作中`; blocked turns use orange `🤖 Claude · 等待你确认` with the existing single-use key buttons. On idle/done the final patch changes the header to green `🤖 Claude · 已完成` and removes the controls. This card also carries status: there is no separate live status card between turns.

The turn retains the last 1,500 Unicode code points of accumulated assistant text with a `仅显示末尾` note when clipped. Tool summaries appear in a collapsed `🔧 工具调用 (N)` panel whose count covers the whole turn and whose contents retain a bounded tail. A large turn never splits into additional messages. Tool results, thinking, system reminders, sidechains and meta/command records are omitted. Desktop user text appears in a small grey `🧑 电脑端输入` card before its turn card. Feishu input is matched once against up to 100 persisted hashes of bridge-sent inputs, expiring after ten minutes, so its transcript copy is not echoed. No transcript content is logged or audited.

Adapters implement `locate(pane)` and `read(path, cursor)` returning `{ items, cursor }`; `{ atEnd: true }` initializes the opaque byte cursor at EOF. Cursors survive restart and tolerate partial UTF-8 lines, truncation and replacement. Reads process at most 1 MiB per poll and skip malformed or oversized records. New/legacy bindings start at current EOF without replaying history. Session paths are re-located on each refresh; a changed `/clear` or `/resume` session starts at its current EOF as well, preventing resumed history from flooding the topic. Content already written before the first observation of that session is intentionally omitted. An existing saved cursor catches up after restart, and pending batches finish before switching sessions.

Codex has an explicit adapter TODO and uses the screen fallback until PID-to-rollout ownership can be verified; newest-cwd alone could select another pane's conversation. Shells and unavailable/unknown adapters also use screen diffs. Agent fallback waits for idle/done or a working-to-idle/done transition; shells wait for about 1.5 seconds of quiet. Fallback agent replies use green completed cards and shell output uses grey `💻 命令输出` code-block cards (last 60 lines, capped at 3,000 characters). This is a best-effort view: full-screen fallback text can disappear between polls, and role separation requires a transcript adapter. All pane reads fetch fresh buffer limits and stay within `viewport_rows + max_offset_from_bottom`; zero-scrollback panes and transcript-backed agents use visible reads only. No reads request application scrollback.

Before sending output the bridge persists a fixed batch of cards/turn snapshots and UUIDs, then saves each successful operation's progress; a transcript byte checkpoint advances only when that batch finishes. The turn ID, bounded text/tool tails, count, status, card ID and patch-attempt time survive restart, so updates continue on the same card. Existing pending text/card batches retain their original chunks and UUIDs across the upgrade. Batches carry the binding generation, checked before every send. A rebind discards unfinished output from the old generation and posts a short notice; an already in-flight API request may finish. A restart resumes a verified binding's batch before taking newer output, even if the adapter is temporarily unavailable. UUIDs are 36 characters and ambiguous retries stop after 55 minutes, inside Feishu's [one-hour deduplication window](https://open.feishu.cn/document/server-docs/im-v1/message/reply). An expired uncertain batch remains paused in state: inspect delivery before deciding to unbind/reopen, which discards the pending batch. Fallback live-card failures do not suppress fallback output; turn publication failures retain the pending turn and checkpoint until reconciled. Recalled, deleted or expired cards are replaced with one new message; temporary errors back off up to 30 seconds. Card publication persists a pending version first and commits its card ID and nonce together only after success. Pending versions are retried on restart; consumed nonces never become valid again. Card clicks acknowledge immediately after the durable local claim with `已收到，处理中…`.

Topic recovery uses the same pending-card/UUID protocol but sends a new thread reply immediately. The old card ID remains active until the new reply commits; afterward, old callbacks fail validation even if the retirement patch is unavailable. Retirement retries only transient network errors, with backoff and a persisted limit of three attempts across restarts. Permanent errors abandon retirement immediately; logs include the topic, card ID, error code/message and disposition. Unknown or obsolete buttons reply `该按钮已停用` without executing an action. State remains version 1; earlier snapshots load with the new optional fields absent. The optional `cardSchemas` registry persists `{schemaVersion, kind}` by message ID for status, turn, menu, root and picker cards, including retired IDs. Every patch renders in that ID's original schema even when terminal modes change. Legacy IDs infer status/picker as 1.0 and turn/menu/root as 2.0; unknown IDs probe 2.0 once only on error 200830, persisting that choice before retry. Retirement uses a final grey header and note without controls.

Moving serializes with open, output and status publication for that pane. It finishes an existing output batch in the old topic first; a failed or uncertain batch leaves the original binding and checkpoint intact for inspection. The destination, generation, nonce and status-card fields change in one state transaction. Transcript cursors and input dedupe hashes survive; old controls become invalid. Root text/time is stored in the optional `topicRoot` field; legacy roots are read and cached on demand, with `--:--` when unavailable. Identity changes refuse a move. If identity changes after root creation but before commit, the new root can remain unbound.

Visible Claude menus get their own reply card even when herdr reports idle; the existing turn/status card stays intact while the menu is open. Each full-width tappable row shows the complete session label, grey details and a cursor marker. Rows stack vertically. Pages contain at most ten items and shrink under the 28 KB payload guard without truncating labels. The same menu card updates for cursor, items, pagination and duplicate-resume confirmation; its ID, nonce and pending publication survive restart. Closing the menu removes its controls and shows `已选择：<label>` in green after a selection, or `菜单已关闭` in grey. A later menu gets a new reply. Opening an already bound terminal while its menu is open refreshes that menu card.

The rows use the official [JSON 2.0 interactive container](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/interactive-container), with `width: "fill"`, `height: "auto"`, nested Markdown and `behaviors: [{type: "callback", value: …}]`. A title too large to fit even one row is refused by the size guard rather than silently shortened. All JSON 2.0 buttons (including Esc/y/n/1/2/3/Ctrl-C/refresh on blocked turns) use `behaviors: [{type: "callback", value: {topic_id, nonce, key}}]`, as documented by the official [JSON 2.0 button guide](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button). The delivered callback still carries `event.action.value`. Old persisted 2.0 payloads are normalized when replayed or patched. The docs also show historical `value` attributes, so using that field alone does not prove the cause of a missing live callback. Every incoming action emits `card_action_received {kind, topic, cardId}` before dedupe, ACL or action validation, including rejected/unknown actions and failed durable claims. These receipt logs omit keys, nonces, tokens and user content; `kind` is the normalized event kind (`button`).

Tapping a list item sends exactly the up/down keys from the captured cursor to that item, then Enter; numbered permission rows send only the digit. The screen is re-read before input, and changed items/cursor/title refuse with `菜单已变化，请刷新`. Operator/chat ACLs, card ID, topic, expiry, nonce and terminal identity remain checked. A tap consumes the menu nonce durably before input; use the refreshed card after each tap. Ordinary blocked prompts retain their individual key controls and current-blocked-state check. No approval is answered automatically.

Bindings, screen IDs, transcript checkpoints, button nonces and bounded dedupe history are persisted with atomic replace and fsync. Input delivery is **at most once** within the retained 10,000-ID history. The SDK callback waits for an atomic, fsynced local dedupe claim before acknowledging; it does not wait for terminal or Feishu API requests. A failed claim requests redelivery. A crash between ACK and execution can lose a queued command: the user sees no reply and must inspect the terminal, then resend if needed. Queued input is never replayed automatically. There is no durable inbox. Inputs run in order per topic; output/card work uses separate per-topic queues and cannot hold up another topic's terminal input. Ambiguous creation may leave an unbound pane; recover with `/t ls` and `/t open`. Only allowed operators in the allowed group can execute; other users get one short refusal per retained user/chat pair. App/bot messages are ignored.

Audit JSONL stores time, operator, topic, pane, action and byte-length/SHA-256 of input, never typed text. SDK logging is disabled to avoid leaking credentials or terminal data. Private state snapshots **do** contain terminal output for restart diffs. Terminal output deliberately goes to the allowed group. Protect its membership and the runtime state directory.

## Feishu console checklist

1. In [Feishu Developer Console](https://open.feishu.cn/app), create an **enterprise self-built application** (not a custom webhook bot), enable the **Bot** application capability, and set its available users to include your operators. Copy App ID/Secret only into the runtime env file.
2. Under **Permissions & Scopes**, request application/tenant permissions:
   - `im:chat:readonly` — verify bot membership and same-name group mode/operator membership, and obtain the fallback group share link. Setup also checks `im:chat:create`, `im:chat:read`, `im:message.group_at_msg:readonly` and `im:message:readonly` from the preset.
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


### 手机卡片说明与颜色

卡片直接说明当前状态及下一步操作：工作中用蓝色，等待你确认用橙色，已完成用绿色，出错用红色；命令行、命令输出、电脑端输入使用灰色。正文使用飞书 Markdown 的 `<font color='green|red|grey'>` 作少量强调，工具摘要和截断说明用灰色；终端代码块保持单色，不转换 ANSI 颜色。[官方 JSON 2.0 富文本组件文档](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text)列明该语法，[颜色枚举](https://open.feishu.cn/document/feishu-cards/enumerations-for-fields-related-to-color)列明颜色取值。选择卡片和非会话状态卡沿用 JSON 1.0 结构，其余会话/输出卡使用 JSON 2.0。

等待确认时会显示终端中的问题，数字按钮带上对应选项文字，点击只发送该数字键，不补回车。默认没有 Enter 按钮：只有画面没有数字选项且明确要求回车（如 Press Enter、Enter to confirm、↵）时，才显示「Enter 继续」。`/t k enter` 始终可用。「Esc 取消」「y 同意」「n 拒绝」「Ctrl-C 中断」发送对应按键，「刷新」重新读取画面；权限、单次使用及过期检查沿用原有规则。

Claude 的 `/resume`、`/model`、`/config` 等列表菜单会另发一张橙色「等待菜单选择」卡片，不修改上一个回复卡片，即使 herdr 状态是空闲。选项单列排列，完整显示会话名，下一行灰色显示时间、HEAD、大小等详情，▶ 标出当前选项，整行可点。直接点一个选项就完成选择，无需输入文字或再点回车。每页最多显示 10 个选项，内容过长时减少每页数量而不截断会话名；更多选项可点「更多…」翻页，并提供「↑ 上一个」「↓ 下一个」。无法可靠解析选项时，显示「↑ 上一个」「↓ 下一个」「Enter 选中」；「Esc 取消」「刷新」始终可点。屏幕的光标、选项或标题改变时，旧选择不发送任何按键，自动更新同一张菜单卡片后再点选。菜单消失时移除控件，显示绿色「已选择：…」或灰色「菜单已关闭」；下一次菜单另发新卡片。

`/resume` 选项与另一仍在运行的 Claude 终端的 `terminal_title_stripped` 完全相同时，按钮显示「⚠️ 已在 <终端编号和标题> 运行」。首次点击只展示风险及「确定恢复」「返回菜单」，不会向终端发送按键；再次点「确定恢复」才选择会话。点击时重新查询 `pane.list`，因此新出现的重复会话也需要确认。确认与菜单快照一起持久保存，重启不会让已使用的 nonce 再次有效。无法解析列表时仍会检查原始光标行中的同名会话，并保护「Enter 选中」；这类菜单同时校验清理后的完整可见屏幕指纹。匹配限于当前可见会话名与 herdr 提供的终端标题；同名可能提示确认，不同名的同一会话无法通过标题识别。

预览隐藏非空白字符中超过一半是块状、框线、盲文字符的装饰行，并隐藏 logo 附近的版本/模型行；`/t screen` 保留原始界面。中文卡片快照见 `test/fixtures/ft16-cards.json`，真实 Claude 启动横幅及来源见同目录 `claude-banner-real.txt` 和 `claude-banner-source.md`。

### 话题标题跟随会话名称

新打开或移到新话题的终端使用机器人卡片作为根消息，标题跟随 herdr 的 `terminal_title_stripped`（Claude 会话名称），缺省使用目录名或「终端」。卡片下方只显示一行灰色的工具、目录和 pane 标识。标题稳定至少 10 秒后更新，每个话题最多每分钟尝试一次；转动符号变化不会更新标题。已发布的名称和更新节流状态会跨重启保留。

在群顶层发消息新建终端时，机器人会另发一个会话话题，原消息只输入一次。原用户话题会收到「已在新话题「名称」打开，请到那里继续」的提示；之后在原话题回复也只会收到提示，不会输入终端。

已有绑定继续工作，旧根消息保留原样；用「移到新话题」或 `/t move` 可创建新的卡片根消息。飞书仅允许更新 14 天内发送的卡片，超出窗口后停止更新该话题标题。旧文本消息受发送者、管理员编辑时限和最多 20 次编辑限制，本地旧状态没有可靠的编辑次数与时限信息，因此不自动编辑旧文本根消息。

API 依据：[更新卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)、[编辑消息](https://open.feishu.cn/document/server-docs/im-v1/message/update)、[撤回消息](https://open.feishu.cn/document/server-docs/im-v1/message/delete)。撤回 API 的 `230026` 明确说明机器人只能撤回自己发送的消息，创建群或成为群主不能据此推断可撤回成员消息。普通 setup 将操作者设为群主，claim setup 不指定群主；这里统一保留用户消息并回复提示。
