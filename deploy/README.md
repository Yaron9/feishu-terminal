# Linux runtime installation

Run this only on the Linux machine already running the intended herdr server. Node.js >=22 and npm are required. Copy this repo there by your preferred file transfer method; no SSH library or port listener is part of the bridge.

```sh
bash deploy/install.sh
```

The installer copies `src/`, `bin/`, package files and README to `~/.local/share/feishu-terminal`, runs `npm ci --omit=dev`, creates private config/state directories and writes `~/.config/systemd/user/feishu-terminal.service` with `Restart=always`. Existing `config.json` and `.env` are preserved. It does not enable or start the service. For updates, stop the service first, rerun the installer, and restart after reviewing configuration.

1. Add `~/.local/bin` to PATH and run `feishu-terminal setup`; open the printed link in Feishu and confirm. Setup saves credentials, creates a topic group, configures the operator, posts usage and checks scopes. See [一次扫码安装](../README.md#一次扫码安装). The generated config uses your home as cwd and `~/.local/state/feishu-terminal` for state/audit.
2. Set `HERDR_SOCKET_PATH` in `~/.config/feishu-terminal/.env` if the intended herdr session uses a different socket. Unset `HERDR_TCP` after isolated tests. The CLI and systemd both load this private file; quote values containing spaces and use literal values, not shell commands.
3. Wait for any tenant approval required for `im:message.group_msg`; until approval, @mention the bot before commands. The [Feishu console checklist](../README.md#feishu-console-checklist) remains a manual fallback if the official launcher cannot configure the app under your tenant policy.
4. Keep using `herdr attach` on that machine to interact with the same panes. Ensure the bridge user can access the intended herdr socket. The bridge does not start or upgrade herdr.

```sh
systemctl --user daemon-reload
systemctl --user enable --now feishu-terminal.service
systemctl --user status feishu-terminal.service
journalctl --user -u feishu-terminal.service -f
```

If the user manager must run after logout or at boot, an administrator may need `loginctl enable-linger YOUR_USER`. The installer only prints this hint and never runs sudo. If Node is installed with a version manager, the unit records its current absolute path; rerun the installer after moving/upgrading that installation.

```sh
systemctl --user disable --now feishu-terminal.service
```

This stops the bridge and leaves herdr panes running. Keep `bridge.json` to retain bindings, dedupe history and transcript checkpoints. State and audit are private files; state contains terminal output snapshots needed for restart diffs. Audit contains only IDs, action, time, length and SHA-256, never input text. Rotate audit externally as needed, preserving permissions. Do not run two instances against the same server/group. Locks and recovery guards record PID and process start time and publish complete records atomically. Dead guard holders are bypassed through exclusive successor guards and pruned after recovery, so a kill during recovery does not require manual deletion. An empty legacy recovery directory has a 30-second grace period. A live holder is never evicted based on age. Corrupt primary locks still require inspection with the service stopped. The state filesystem must support hard links.

Feishu 14-day edit limits and recalled/deleted screen cards cause automatic card replacement. Temporary card failures back off without suppressing text output. After uncertain input, inspect the posted screen, optionally clear the line with `/t k ctrl+u`, then send `/t ok`; ordinary input stays refused until that acknowledgement. The bridge will not replay the command. The bounded dedupe window holds 10,000 identifiers (usually 5,000 message/event pairs), not an unlimited lifetime history. The SDK waits for the local durable claim before ACK; a crash between claim and execution intentionally favors no duplicate execution over automatic delivery. Output batches resume with fixed UUIDs, and uncertain sends pause before the one-hour dedupe window expires; inspect delivery before choosing to discard a paused batch by unbinding.

Pane IDs are scoped to a server. Each binding also records `terminal_id`, workspace and tab. Startup, reconnect and write checks freeze bindings when these no longer match or cannot be confirmed. Legacy bindings without identity also freeze: inspect `/t ls`, then `/t open <pane_id>` to explicitly rebind or `/t close` to unbind. The pane must belong to workspace `feishu`. `/t ok` acknowledges uncertain input only; it cannot override an identity freeze.
