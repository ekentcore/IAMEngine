#!/usr/bin/env bash
# One-time supervisor setup for a LINUX central runner (e.g. a small Azure VM): install a systemd
# service that keeps Start-IamRunner.ps1 running and relaunches it within seconds on ANY exit — a crash,
# the stall watchdog's restart, or a self-update. The Linux counterpart of install-launchd.sh (macOS)
# and install-task.ps1 (Windows). Restart=always ≈ launchd KeepAlive.
#
# Run with sudo. Override defaults via env:
#   APP_URL  AGENT_ID  RUNNER_DIR  PWSH  RUNNER_API_TOKEN  STALL_TIMEOUT  RUN_USER  POOL_SIZE  RUNNER_ENROLL_TOKEN
set -euo pipefail

APP="${APP_URL:?set APP_URL (the URL the runner polls, e.g. https://iam.example.com)}"
AGENT="${AGENT_ID:?set AGENT_ID (this runner agent id from the Agents page)}"
DIR="${RUNNER_DIR:-/opt/iam-runner}"
PWSH="${PWSH:-$(command -v pwsh || echo /usr/bin/pwsh)}"
TOKEN="${RUNNER_API_TOKEN:-}"
STALL="${STALL_TIMEOUT:-600}"
RUN_USER="${RUN_USER:-iamrunner}"
# POOL_SIZE=1 (default) runs Start-IamRunner.ps1 directly — byte-identical ExecStart to before.
# POOL_SIZE>1 runs Start-IamRunnerPool.ps1 -PoolSize N (N distinct-identity members; needs #4's governor).
POOL="${POOL_SIZE:-1}"
ENROLL="${RUNNER_ENROLL_TOKEN:-}"
UNIT="/etc/systemd/system/iam-runner.service"
ENVFILE="/etc/iam-runner.env"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo (registering a system service + writing /etc needs root)"; exit 1; }
[ -x "$PWSH" ] || command -v "$PWSH" >/dev/null 2>&1 || { echo "pwsh not found at '$PWSH' — install PowerShell 7 or set PWSH=/path/to/pwsh"; exit 1; }
[ -f "$DIR/Start-IamRunner.ps1" ] || { echo "runner not found at $DIR/Start-IamRunner.ps1 — pull the bundle there first"; exit 1; }

# Choose the supervised command. Size 1 = the runner directly (unchanged); size >1 = the pool supervisor.
if [ "$POOL" -gt 1 ]; then
  [ -f "$DIR/Start-IamRunnerPool.ps1" ] || { echo "pool supervisor not found at $DIR/Start-IamRunnerPool.ps1 — pull a runner build >= 1.95.0"; exit 1; }
  EXEC_START="${PWSH} -NoProfile -ExecutionPolicy Bypass -File ${DIR}/Start-IamRunnerPool.ps1 -AppUrl ${APP} -AgentId ${AGENT} -PoolSize ${POOL} -StallTimeoutSeconds ${STALL}"
else
  EXEC_START="${PWSH} -NoProfile -ExecutionPolicy Bypass -File ${DIR}/Start-IamRunner.ps1 -AppUrl ${APP} -AgentId ${AGENT} -StallTimeoutSeconds ${STALL}"
fi

# Dedicated unprivileged service account (the cloud-only runner needs no root). Create if missing + own the dir.
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "==> creating service user '$RUN_USER'"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
fi
chown -R "$RUN_USER":"$RUN_USER" "$DIR"

# Secret + supervised flag go in a root-only EnvironmentFile, NOT the unit/argv (so the token never
# shows in `systemctl show` or `ps`).
echo "==> writing $ENVFILE (chmod 600)"
{
  echo "RUNNER_SUPERVISED=1"
  [ -n "$TOKEN" ] && echo "RUNNER_API_TOKEN=$TOKEN"
  [ -n "$ENROLL" ] && echo "RUNNER_ENROLL_TOKEN=$ENROLL"
} > "$ENVFILE"
chmod 600 "$ENVFILE"

echo "==> writing $UNIT"
cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=iam-engine central runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${DIR}
EnvironmentFile=${ENVFILE}
ExecStart=${EXEC_START}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl enable --now iam-runner

echo "==> systemd is now supervising the runner (iam-runner.service)."
echo "    status:  systemctl status iam-runner"
echo "    logs:    journalctl -u iam-runner -f"
echo "    restart: systemctl restart iam-runner"
echo "    stop:    systemctl stop iam-runner   (disable: systemctl disable --now iam-runner)"
