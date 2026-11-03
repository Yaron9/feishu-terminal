# 飞书机器人设置

本页依据 `src/setup.js`、`src/feishu.js`、`src/feishu-ws.js`。需要可创建应用和群的飞书租户；当前 setup 拒绝 Lark。所有标识均为占位值。

## 1. 准备主机与操作者

在运行 hc 或 legacy herdr 的 Linux 主机上，以终端所属用户安装 Node.js >=22、npm，再从源码目录执行：

```sh
bash deploy/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

安装器建立运行目录、配置和 systemd user unit，不启动服务。重新配置前先 `systemctl --user stop feishu-terminal.service` 并备份。setup 不清除旧绑定；更换群或应用后须核对历史状态归属。

若已知操作者在该应用下的 open_id，使用：

```sh
feishu-terminal setup --new-app --new-group --operator ou_xxx
```

即 `feishu-terminal setup --new-app --new-group --operator <open_id>`。open_id 是应用范围内的用户标识，不可随意借用其他应用的标识。不知道时可省略 `--operator`，使用注册结果或后续入群认领。

## 2. 手机确认创建应用

setup 使用固定版本官方 SDK 的 `registerApp({ createOnly: true, ... })` 设备流程，预填名称“VPS 终端”、描述“飞书话题 ↔ VPS herdr 终端”，采用智能体预设并额外申请 `im:message.group_msg`、`im:chat:readonly`。

终端显示以下形式，链接中的值由 SDK 生成：

```text
CONFIG <配置绝对路径>
SETUP_URL <https确认链接>
SETUP_EXPIRES <UTC时间>
```

`SETUP_URL`、`SETUP_EXPIRES` 写 stdout；`CONFIG`、进度、权限表、错误和 `SETUP OK` 写 stderr。用手机飞书打开完整链接并确认创建应用；也可自行用二维码工具编码该链接扫码。CLI 不显示额外的输入问答，也不直接输出二维码。审批提示由飞书和租户策略决定。

链接和有效期保存为 `${STATE:-$HOME/.local/state/feishu-terminal}/setup-url.txt`（0600）。到期或拒绝退出 2，可重跑 setup。收到 `slow_down` 时 SDK 自动延长轮询，无需另开一轮。

**失败或中断后运行不带 `--new-app` 的 `feishu-terminal setup`。** 它先验证配置旁 `.env` 的已有凭据并续接；没有已存应用、获取 token 失败或明确传 `--new-app` 才重新注册。`--new-group` 为本应用请求新群；失败后同样直接重跑以续接这次操作。

## 3. 建群、认领与落盘

setup 创建私有普通群，`group_message_type: "thread"`，不是客户端独立的“话题群”类型。已知操作者时将其设为 owner 并加入群；机器人须在群内。一个项目一个群，每个终端/Claude 会话在独立话题中交互。

保留已存群前验证当前机器人确实在群里。建群前查找同名“VPS 终端”群，仅在机器人已入群、消息模式 thread、操作者已入群时复用；多个合格候选会以 `ambiguous_setup_groups` 停止，需先指定正确群。

注册结果没有 open_id 且没有 `--operator` 时，先保存凭据，创建仅有机器人的新群，然后输出：

```text
SETUP_JOIN_URL <入群链接>
SETUP claim: 15 分钟内入群并发一条 @机器人 消息；本新群第一位发言的人将成为唯一操作者。
```

仅将链接交给预期操作者。该新群第一位用户消息的 open_id 先持久化，再在群内确认；认领消息不会执行终端命令。期限从建群起 15 分钟，重跑不延长。超时或缺失操作者退出 3（`claim_expired` / `missing_operator`），可用 `feishu-terminal setup --operator ou_xxx` 续接已有应用与群。

成功会写入：

- 配置旁 `.env`：合并 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，保留其他行；已有文件先备份为 `.env.bak-<timestamp>-<uuid>`。
- `config.json`：`chatIds: ["oc_xxx"]`、`operatorOpenIds: ["ou_xxx"]`；缺失或示例 cwd 替换为用户 home，缺失或示例 `stateFile` / `auditFile` 替换为状态目录的绝对路径，其他自定义值保留。凭据不写 JSON。
- 状态目录 `setup-progress.json`：`registered`（app_id，无 secret）、群 chat_id、操作者及 `configured`、`welcomed`、`scopes_checked` 等恢复阶段；避免重复欢迎消息与已完成的检查。

凭据、备份、配置、进度和链接文件以 0600 原子写入，目录以 0700 创建；Windows 需管理等价 ACL。最后显示权限表与 `SETUP OK`（退出 0）；其他失败退出 1，不能视为配置完成。

## 4. 权限与长连接

setup 检查下列 tenant scopes（`NEEDED_SCOPES`），手工配置也按此清单申请：

| Scope | 用途 |
| --- | --- |
| `im:chat:create` | 创建项目群 |
| `im:chat:read` | 群信息/群操作所需的预设权限 |
| `im:chat:readonly` | 群信息、成员/机器人入群核对、群分享链接 |
| `im:message.group_at_msg:readonly` | 接收 @机器人 消息，支持认领和全群消息待批期间使用 |
| `im:message.group_msg` | 接收群内非 @ 消息，可能需管理员审批 |
| `im:message:send_as_bot` | 机器人发消息、话题回复与卡片更新 |
| `im:message:readonly` | 消息/话题内容读取与检查 |

检查时只认可已授权 tenant scope。除 `im:message.group_msg` 可待批外，缺少必需权限会以 `required_scopes_missing` 失败。全群消息待批时，**顶层消息、认领消息和话题内回复，每条都要 @机器人**。

在飞书开发者后台检查两处配置：

1. **事件与回调 → 事件配置**：接收方式选择长连接（WebSocket），添加 `im.message.receive_v1`。
2. **事件与回调 → 回调配置**：回调方式也选择长连接，添加卡片交互回调 `card.action.trigger`。

运行时在同一 dispatcher 注册这两个事件，通过 `/callback/ws/endpoint` 获取连接配置，出站连接飞书，无需公网回调地址。setup 将权限和预设交给 SDK，自身源码没有逐项设置这两个订阅；自动注册成功后仍应核对后台并实际验收。后台若要求先建立连接，可启动桥接后保存订阅。

## 5. 无法自动注册时手工配置

1. 在飞书开发者后台创建企业自建应用，启用机器人能力，为测试操作者设置应用可用范围。
2. 在“凭证与基础信息”获取 App ID、App Secret，写入 `~/.config/feishu-terminal/.env`，而非源码 `.env.example`：

   ```dotenv
   FEISHU_APP_ID=cli_xxx
   FEISHU_APP_SECRET=<APP_SECRET>
   ```

   Linux 执行 `chmod 600 ~/.config/feishu-terminal/.env`。不要提交凭据、备份或注册链接；检查运行环境中是否有覆盖 `.env` 的旧值。
3. 在权限管理申请上表全部权限，发布应用版本并完成租户管理员审批；按上一节配置事件与卡片长连接回调。
4. 创建专用群并添加机器人，确认 `group_message_type: "thread"`。也可运行 `feishu-terminal setup --new-group --operator ou_xxx` 使用有效的已存凭据建群；不要加 `--new-app`。
5. 将一个群 ID 填入 `chatIds`，本应用下操作者 open_id 填入 `operatorOpenIds`；设置已有绝对目录 `defaultCwd`、后端和状态路径。可复制 `config.example.json` 后编辑。无需通讯录查询或用户 OAuth。
6. 启动桥接，检查日志，再用授权手机在群顶层发 `@机器人 pwd`，进入机器人新建的话题回复 `@机器人 echo hello`，测试刷新和按键；全群消息获批后再测不 @ 的消息。确认非白名单用户不能执行命令。

## 6. 启动与验收

```sh
systemctl --user daemon-reload
systemctl --user enable --now feishu-terminal.service
journalctl --user -u feishu-terminal.service -f
```

确认后端 socket 可由服务用户访问。自定义配置时，CLI 和 systemd override 的 `FEISHU_TERMINAL_CONFIG` 要指向同一绝对路径。agent 接入、命令、升级备份及故障排查见 [README](../README.md)。

setup 成功、API 成功或模拟事件 selftest 均不能代替真实入站验收；最后必须在手机实际发消息并点击按钮。
