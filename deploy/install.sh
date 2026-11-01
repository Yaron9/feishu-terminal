#!/usr/bin/env bash
set -euo pipefail
umask 077

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$HOME/.local/share/feishu-terminal"
config_dir="$HOME/.config/feishu-terminal"
state_dir="$HOME/.local/state/feishu-terminal"
unit_dir="$HOME/.config/systemd/user"
bin_dir="$HOME/.local/bin"

command -v node >/dev/null || { echo 'Install Node.js >=22 first.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Install npm first.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo 'Node.js >=22 is required.' >&2; exit 1; }

mkdir -p -- "$runtime_dir" "$config_dir" "$state_dir" "$unit_dir" "$bin_dir"
if [[ "$(cd -- "$runtime_dir" && pwd)" != "$source_dir" ]]; then
  cp -- "$source_dir/package.json" "$source_dir/package-lock.json" "$source_dir/README.md" "$runtime_dir/"
  cp -R -- "$source_dir/src" "$source_dir/bin" "$runtime_dir/"
fi
cp -- "$source_dir/config.example.json" "$source_dir/.env.example" "$config_dir/"
if [[ ! -e "$config_dir/config.json" ]]; then
  node --input-type=module - "$config_dir" "$state_dir" "$HOME" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [configDir, stateDir, userHome] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(configDir, 'config.example.json'), 'utf8'));
config.defaultCwd = userHome;
config.stateFile = join(stateDir, 'bridge.json');
config.auditFile = join(stateDir, 'audit.jsonl');
writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
NODE
fi
if [[ ! -e "$config_dir/.env" ]]; then
  sed '/^FEISHU_TERMINAL_CONFIG=/d' "$source_dir/.env.example" > "$config_dir/.env"
fi
chmod 700 -- "$config_dir" "$state_dir"
chmod 600 -- "$config_dir/config.json" "$config_dir/.env"
cd -- "$runtime_dir"
npm ci --omit=dev
chmod 755 -- "$runtime_dir/bin/feishu-terminal.js"
ln -sfn -- "$runtime_dir/bin/feishu-terminal.js" "$bin_dir/feishu-terminal"

node_path="$(node -p 'process.execPath')"
node_path="${node_path//\\/\\\\}"
node_path="${node_path//\"/\\\"}"
node_path="${node_path//%/%%}"
cat > "$unit_dir/feishu-terminal.service" <<UNIT
[Unit]
Description=Feishu topics to local herdr bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.local/share/feishu-terminal
# The CLI selects the installed config (or FEISHU_TERMINAL_CONFIG) and loads its sibling .env.
ExecStart="$node_path" "%h/.local/share/feishu-terminal/bin/feishu-terminal.js"
Restart=always
RestartSec=5
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
UNIT

cat <<EOF
Runtime: $runtime_dir
Run one-scan setup (open the printed confirmation link in Feishu):
  export PATH="\$HOME/.local/bin:\$PATH"
  feishu-terminal setup
If needed, set HERDR_SOCKET_PATH in $config_dir/.env.
Then run:
  systemctl --user daemon-reload
  systemctl --user enable --now feishu-terminal.service
For startup without an interactive login, ask your administrator about:
  loginctl enable-linger $USER
The installer has not started the service and has not run sudo.
EOF
