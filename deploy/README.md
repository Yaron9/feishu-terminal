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

This stops the bridge and leaves herdr panes running. Keep `bridge.json` to retain bindings, dedupe history and transcript checkpoints. State and audit are private files; state contains terminal output snapshots needed for restart diffs. Audit contains only IDs, action, time, length and SHA-256, never input text. Rotate audit externally as needed, preserving permissions. Do not run two instances against the same server/group. The PID lock rejects concurrent local instances and recovers a stale dead-PID lock; an invalid/empty lock or abandoned `.lock.recovery` directory requires manual inspection while the service is stopped.

Feishu 14-day edit limits or a recalled/deleted screen card may require `/t close` then `/t open <pane_id>` to create a fresh topic/card. A network error after input is uncertain: inspect the screen; the bridge will not replay the command. The bounded dedupe window holds 10,000 identifiers (usually 5,000 message/event pairs), not an unlimited lifetime history. A crash between dedupe claim and input intentionally favors no duplicate execution over automatic delivery.

Before changing the herdr server/session behind an existing state file, stop the service and choose a new `stateFile` and `auditFile`. Pane IDs are scoped to a server and must never be reused with old topic bindings on a different session.
