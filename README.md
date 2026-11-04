# Feishu Terminal

飞书群话题 ↔ 本机终端桥接。一个项目使用一个专用群，一个 Claude 会话对应一个话题；手机与桌面操作同一个正在运行的会话。也支持 Codex 和普通 shell。桥接运行在终端所在主机，通过飞书 WebSocket 长连接接收消息，通过本地 socket 控制终端，无需开放公网监听端口。

## 环境要求

- Node.js >= 22、npm。
- 允许创建应用、机器人和群的飞书租户，必要时由管理员审批权限。Lark 租户目前会被 setup 明确拒绝，尚不支持。
- 至少一个已安装并运行的终端后端：首选 herdr-core（`hc`，0.1.16+，需兼容 generation 1 协议），或 legacy herdr 0.9.5（protocol 22）。桥接不会安装或升级后端。
- 生产部署使用 Linux；Claude 自动会话跟随依赖本机 `/proc`、同用户的 `~/.claude/sessions/<pid>.json`。Windows 可运行开发测试。

## 安装与机器人配置

在运行终端后端的 Linux 主机上，以同一个用户执行：

```sh
bash deploy/install.sh
export PATH="$HOME/.local/bin:$PATH"
feishu-terminal setup --new-app --new-group --operator ou_xxx
```

通用形式为 `feishu-terminal setup --new-app --new-group --operator <open_id>`。`ou_xxx` 必须替换为本应用下操作者的 open_id。setup 输出 `SETUP_URL <url>`、`SETUP_EXPIRES <UTC时间>`；用手机飞书打开完整链接，或将链接转成二维码扫码，确认创建“VPS 终端”应用。CLI 不会交互询问 App Secret，也不会自行渲染二维码。最终须看到 stderr 的 `SETUP OK` 才启动服务。

**中断后直接运行 `feishu-terminal setup` 续接，不要再次加 `--new-app`。** 未指定操作者且注册未返回 open_id 时，会输出 `SETUP_JOIN_URL`，在 15 分钟内入群并 @机器人发言以认领。逐步配置、权限清单、手工回退和退出码见 [飞书机器人设置](docs/feishu-setup.md)。

setup 写入配置旁 `.env` 的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，更新配置中的单个 `chatIds`、`operatorOpenIds`，为未设置的目录和状态路径填入默认值；这些私有文件以 0600 写入。已有自定义配置尽量保留。群采用普通群的 `group_message_type: "thread"` 消息模式。

确认后端端点及配置后启动：

```sh
systemctl --user daemon-reload
systemctl --user enable --now feishu-terminal.service
journalctl --user -u feishu-terminal.service -n 30
```

权限 `im:message.group_msg` 审批完成前，每条消息（包括新话题和话题回复）都必须 @机器人。授权后，在专用群顶层发 `pwd` 验证新终端，在机器人新建的话题里回复 `echo hello`，再测试按钮是否生效。

## 将 agent 接入飞书

先按所使用的 herdr-core 发行版说明安装 `hc` CLI 并启动 core 服务；确认 `hc --help` 可用。桥接不提供 hc 安装器。在桌面连接的 hc 终端中直接运行 `claude`，或者创建后台终端：

```sh
hc run --bg --name <name> --cwd <dir> claude
```

`<dir>` 使用项目的真实目录。Codex 同理可在 hc 终端中运行 `codex`；Claude 的会话跟随规则不适用于 Codex。仍使用 legacy herdr 的机器，也可在其终端中直接运行 `claude`。

手机发送 `/t ls`，在列表中点「打开」：未绑定终端建立新话题，已绑定终端在原话题发送新屏幕卡片，使话题回到列表顶部。电脑端输入与 agent 输出在对应话题同步；话题内回复发到同一终端。读取已有会话从当前检查点开始，不回放全部历史。Claude 的 `/resume`、`/model`、`/config` 菜单可直接点击选项，无法可靠解析时使用方向键与 Enter。

恢复既有 Claude 会话时，在同一项目目录的 hc/herdr 终端运行：

```sh
claude --resume <sessionId>
```

默认每秒检查本机同会话进程，以启动时间最新的进程为准：先将原话题指向新终端、持久保存新绑定，再重新核实新旧进程的 Claude 名称、会话 ID 和启动时间，向经核实的旧进程发送 SIGTERM。最多等待 10 秒，不发送 SIGKILL；未退出或无法核实的 PID 会提示检查。新进程只在普通 SSH 中时，仅警告，不终止进程；目标终端已绑定其他话题时不抢占。远程 hc 终端可控制，但自动跟随只检查本机进程。

本仓库未附带 `skills/hc/SKILL.md`。向 Claude Code / Codex 的项目说明加入以下操作约束即可：

- 优先使用 `hc`；已移除 legacy herdr 的机器不要运行裸 `herdr` 命令。
- 只操作、关闭自己启动的终端，记录创建结果的终端编号；不要清理用户桌面或其他 agent 的终端。
- 先在 hc/herdr 中启动 agent，再通过 `/t ls` →「打开」接入。普通 SSH 进程不等于可控制的终端。
- 输入断线或超时后先检查屏幕，不自动重发命令。

## 配置与后端

默认读取 `~/.config/feishu-terminal/config.json` 及同目录 `.env`，不读取当前工作目录的 `config.json`。`FEISHU_TERMINAL_CONFIG` 可指定另一绝对路径；系统环境变量优先于 `.env`。示例见 [config.example.json](config.example.json) 和 [.env.example](.env.example)。

```json
{
  "chatIds": ["oc_xxx"],
  "operatorOpenIds": ["ou_xxx"],
  "defaultCwd": "/absolute/path/to/project",
  "backends": ["hc", "herdr"],
  "newTerminalBackend": "hc",
  "sessionFollow": "newest",
  "stateFile": "./state/bridge.json",
  "auditFile": "./state/audit.jsonl"
}
```

`chatIds` 必须只有一个群，`operatorOpenIds` 至少一个；`defaultCwd` 必须是存在的绝对目录。省略 `backends`、`newTerminalBackend`、`sessionFollow` 时，默认分别为 `["hc", "herdr"]`、`"hc"`、`"newest"`。`sessionFollow: "warn"` 关闭自动迁移和终止，仅保留重复会话警告。`newTerminalBackend` 必须在 `backends` 中；仅使用 legacy herdr 时同时设置 `["herdr"]` 和 `"herdr"`。仅使用 hc 时设 `["hc"]`，避免探测不存在的旧后端。

| 后端 | 端点配置 |
| --- | --- |
| herdr-core | `HC_TERMINAL_SOCKET` 优先于 `HC_SOCKET_PATH`；默认 `${XDG_RUNTIME_DIR:-/run/user/<uid>}/herdr-core/default.sock` |
| legacy herdr | `HERDR_SOCKET_PATH`，默认 `~/.config/herdr/herdr.sock`；测试专用 `HERDR_TCP=127.0.0.1:49450` 优先于 socket |

hc 编号如 `hc:t1`，远程如 `hc:host/t3`，legacy 编号如 `w1:p2`。一个后端不可用不阻断另一个后端。普通 hc 屏幕读取使用 `terminal.read` 的 `lines: 0`，不会滚动或改变终端尺寸。hc 写操作等待窗口为 60 秒；返回 `started: false/null` 不代表输入失败。`/t raw` 使用短暂 framed attach 发送带括号粘贴的文字，不追加 Enter；确认仅表示 core 处理了输入帧，不保证程序执行完成。

## 手机命令

| 输入 | 行为 |
| --- | --- |
| `/t ls` | 列出终端，点「打开」「关闭」或「移到新话题」 |
| `/t open <终端编号>` | 打开未绑定终端或恢复原话题；legacy 文本命令仅允许 `feishu` workspace，列表可选择桌面终端 |
| `/t screen` | 在绑定话题刷新状态，发送完整当前视口的屏幕卡片（长屏分片） |
| `/t k <keys>` | 发送 1–8 个空白分隔的允许按键，如 `/t k ctrl+c` |
| `/t move` / `/t move <终端编号>` | 将当前或指定已绑定终端移到新话题，保留读取位置 |
| `/t close` | 话题内选择「仅解绑」「关闭终端」「取消」；群顶层显示列表 |
| `/t close --kill` | 直接关闭当前终端并解绑，结束其中的程序 |
| `/t raw <内容>` | 仅输入不追加 Enter；保留一个分隔符之后的文字与空白 |
| `/t ok` | 检查过不确定输入结果后解除输入保护 |
| 其他文字，包括 `/compact`、`/help` | 在绑定话题原样转发；群顶层创建新终端并发送首条输入 |

按键允许：`enter esc tab up down left right ctrl+c ctrl+u y n 1`–`9 shift+tab home end backspace delete pageup pagedown`。未绑定话题里的回复不会自动新建终端。只支持文字消息，图片、文件和富文本不会作为终端输入。

顶层消息创建终端后，机器人发布单独的根卡片，并提示到新话题继续。标题跟随会话名称，缺省采用目录名。找不到原话题时可点「移到新话题」。桌面终端及工作中、等待确认的 agent 在菜单关闭时需要二次确认；显式 `--kill` 直接执行。

按钮单次使用、10 分钟过期；点击时重新检查操作者、群、话题、卡片、nonce 与终端身份。菜单变化后旧选项失效。卡片颜色：蓝色工作中，橙色等待确认，绿色完成，红色出错，灰色命令行/输出。`/t screen` 保留当前完整界面，普通预览会隐藏装饰性 logo。

## 运维、备份与回滚

`deploy/install.sh` 复制代码并安装依赖到 `~/.local/share/feishu-terminal`，创建 `~/.local/bin/feishu-terminal` 和 `~/.config/systemd/user/feishu-terminal.service`。保留已有配置与 `.env`，不会启动服务或执行 sudo。Node 路径写入 unit，移动 Node 安装位置后需重新安装 unit。需退出登录后运行时，请管理员按需配置 `loginctl enable-linger <user>`。

| 内容 | 默认位置 |
| --- | --- |
| 配置、凭据 | `~/.config/feishu-terminal/config.json`、同目录 `.env` |
| 绑定、去重、读取检查点和输出快照 | `~/.local/state/feishu-terminal/bridge.json` |
| 审计 | `~/.local/state/feishu-terminal/audit.jsonl` |
| setup 进度、注册链接 | 同一状态目录 `setup-progress.json`、`setup-url.txt` |
| 服务日志 | `journalctl --user -u feishu-terminal.service`；前台运行则 stdout/stderr |

相对 `stateFile`、`auditFile` 从配置所在目录解析；直接复制示例时落在配置目录下 `state/`。setup/安装器会把示例路径换成上述绝对默认值。`STATE` 仅选择 setup/selftest 状态目录，不覆盖桥接配置的状态路径。审计需外部轮转并保持私有权限。

升级前停止桥接，备份实际配置、状态、unit 和旧运行目录：

```sh
systemctl --user stop feishu-terminal.service
umask 077
backup="$HOME/feishu-terminal-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
cp -a "$HOME/.config/feishu-terminal" "$backup/config"
cp -a "$HOME/.local/state/feishu-terminal" "$backup/state"
cp -a "$HOME/.local/share/feishu-terminal" "$backup/runtime"
cp -a "$HOME/.config/systemd/user/feishu-terminal.service" "$backup/feishu-terminal.service"
# 如使用自定义状态/配置路径，也备份相应文件。
bash deploy/install.sh
systemctl --user daemon-reload
systemctl --user start feishu-terminal.service
```

回滚时先停服务，另存升级后的状态，再恢复备份的 runtime、配置、状态和 unit 到原路径，执行 daemon-reload 并启动。恢复状态前核对后端服务和终端真实身份；备份后的输入/输出投递记录可能丢失，须检查实际屏幕及飞书消息。保留 `bridge.json` 才能保留绑定、去重和读取位置；不要把它指向另一个终端服务器。停止桥接不会关闭后端终端。

同一状态/群只运行一个实例。状态文件系统需支持 hard link；实例锁校验 PID 和启动时间，不因锁年龄抢占活实例。遇到损坏的锁，停服务检查进程后处理，不能直接删除仍在使用的锁。

## 安全边界

机器人相当于服务用户的本地 shell。只有 `operatorOpenIds` 白名单内操作者可以驱动，群也必须匹配配置。使用专用群；授权操作者的普通文字就是可执行输入，后端 socket 不应共享给不可信用户。

凭据只放运行环境或配置旁的 `.env`，不放 JSON、仓库或文档。setup 以 0600 写入 `.env`、其备份、配置及进度（Linux 文件权限；Windows 需管理等价 ACL）。运行时 token 仅在内存使用。审计记录时间、ID、动作、输入字节数和 SHA-256，不保存输入正文；会话迁移另记录 PID 等元数据。状态文件含输出快照、路径等内容，飞书话题也含实际终端内容，都应按私有数据保护。

输入先持久化意图，失败或结果不确定时不会自动重发，保护跨重启保留。先 `/t screen` 核查，必要时 `/t k ctrl+u` 清空输入行，确认后 `/t ok`。后者只确认输入结果，不能覆盖终端身份冻结。事件去重有保留窗口（10,000 个标识），不是永久消息历史；崩溃后宁可不自动执行，也避免重复输入。

## 故障排查

| 提示或日志 | 含义与处理 |
| --- | --- |
| `backend_unreachable <backend> ...` | 后端不可达或响应不可用；检查 core/legacy 服务、socket 路径、版本及同用户访问权限；不要重发不确定输入 |
| `暂时连不上终端服务，正在重试` | 不可用超过 120 秒；退避重试至多间隔 30 秒，保留绑定、检查点与待发输出；恢复并验证身份后继续 |
| `终端已变化` | 终端不存在或身份确实不匹配，暂停同步；先 `/t ls` 检查并点「打开」；相同身份重新出现可自动恢复，新身份需明确重新绑定 |
| `card_retirement_failed` | 新卡片产生但旧卡片退役编辑失败；按日志 `code` 检查权限、编辑时限或网络。瞬时网络失败总计最多 3 次尝试，其后放弃退役；使用最新卡片 |
| `startup_failed` | 检查参数、凭据、配置、cwd、状态权限及实例锁；前台与 systemd 必须选择同一配置 |
| setup 权限 not granted | 检查权限、版本发布及租户审批；全群消息待批时每条消息 @机器人 |
| 消息收到但按钮无效 | 检查 `card.action.trigger` 的长连接回调配置；重新 `/t ls` 获取未过期卡片 |
| 输入后要求检查屏幕 | 可能已经发送成功，按 `/t screen` → 核查 → `/t ok` 处理，切勿盲目重发 |

只有确定的身份变化才冻结绑定；临时连接故障保留原绑定并重试。卡片过期、撤回或飞书编辑限制可能触发卡片替换，网络失败不会自动重放终端输入。

## 开发与验证

```sh
npm ci
npm test
node --test test/router.test.js
# 指定单文件的通用形式：node --test test/<file>
```

使用 Node 内置 test runner，包含本地假后端、模拟飞书和协议测试。常规测试不需要生产凭据或运行真实 agent；数量随代码变化。常驻运行使用 Node 原生 `fetch` / `WebSocket`，固定版本的可选 SDK 仅在应用注册时延迟加载；setup 和开发测试需正常 `npm ci`。

`src/router.js` 解析命令，`src/backends/` 统一后端，`src/feishu*.js` 处理 API/长连接，`src/store.js` 保存状态和审计，`src/session-follow.js` 校验 Claude 进程，`src/bridge.js` 编排输入、话题与卡片，`src/transcripts/` 读取本机会话日志。

需真实端到端检查时，可显式运行 `feishu-terminal selftest --herdr-socket /absolute/path/to/isolated.sock`。此命令面向 legacy herdr，需要已配置的真实应用/群，会发送 `[selftest]` 消息、操作本次创建的测试终端，不代表 hc 后端或真实入站消息/按钮投递已验收。同一应用多条长连接可能分摊事件，应选择无用户输入时段，最后从手机实际验证。

## 作为库嵌入

宿主独占飞书长连接时，可把事件交给同一个桥接核心；库不会连接飞书、加载 `.env`、读取配置文件或获取实例锁。

```js
import { createBridge, createConfigRegistry } from 'feishu-terminal';

const registry = createConfigRegistry(config); // 也可注入自己的 get(chatId) / list()
const bridge = createBridge({
  config, transport, registry, backends,
  storeFile: '/private/state/bridge.json',
  auditFile: '/private/state/audit.jsonl',
  log: code => console.error(code),
  clock: Date.now,
});
await bridge.start();
const used = await bridge.handle(rawEvent);
// used === false 时，由宿主继续路由事件。
await bridge.stop();
```

`backends` 使用现有后端接口，负责终端操作及订阅；`stop()` 会释放这些后端。`transport` 提供异步方法
`send(chatId, content, uuid?)`、`reply(topicId, content, type?, uuid?)`、`patch(messageId, card)`、
`getMessage(messageId)`，具体约定见 `src/transport.js`。其中 `send` 创建话题根消息，`reply` 在线程内回复，
`patch` 同时负责卡片更新和旧卡片停用。宿主可通过 `transport.botOpenId` 提供机器人身份以移除自身 @ 标记。

`handle(rawEvent)` 返回 `Promise<boolean>`，接收含 `header.event_type` / `event` 的原始事件，
也接受 SDK 展平后的 `event_type` / `event_id` 字段；支持 `im.message.receive_v1` 和 `card.action.trigger`。
未知群、非本桥接卡片、未知事件类型均返回 `false`，不写状态、不发消息。已接管的重复事件和无权限操作返回 `true`。
卡片回调按群路由，并核对本地卡片记录、nonce 和操作权限；升级前未标记的旧卡片也可使用。
独立运行入口使用 `accept(rawEvent)`，仅等待本地持久化去重，后台排队执行，以满足飞书回调时限。

`registry.get(chatId)` 返回 `{chatId, project, cwd, machine, operatorOpenIds}` 或 `null`，`list()` 返回群条目数组。
内置 registry 合并 `config.chatIds` 和可选的 `config.groups`；每群可配置 `project`、`cwd`、`machine`、
`operatorOpenIds`，未配置的目录和权限继承全局值，显式空权限数组表示禁止控制。
原有单群配置和 version 1 状态文件保持兼容，无需迁移。库不包含按需唤醒或空闲回收。
