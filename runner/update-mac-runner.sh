#!/usr/bin/env bash
# Update + relaunch the macOS iam-engine runner locally, bypassing the in-app self-update (which can
# stall on a slow file pull). Kills any running runner, re-downloads the bundle from the app with
# timeouts, and relaunches detached (survives closing the terminal). Logs to $RUNNER_DIR/runner.log.
#
# Override any of these via env vars; the defaults match this Mac's setup:
#   APP_URL=http://192.168.0.81:3000  AGENT_ID=cmq585c0n0001cc3fbry3z33g  ./update-mac-runner.sh
set -euo pipefail

APP="${APP_URL:-http://192.168.0.81:3000}"
AGENT="${AGENT_ID:-cmq585c0n0001cc3fbry3z33g}"
DIR="${RUNNER_DIR:-$HOME/iam-runner}"
PWSH="${PWSH:-$HOME/.local/pwsh/pwsh}"
TOKEN="${RUNNER_API_TOKEN:-}"

HDR=(-H 'ngrok-skip-browser-warning: true')
[ -n "$TOKEN" ] && HDR+=(-H "Authorization: Bearer $TOKEN")

command -v "$PWSH" >/dev/null 2>&1 || { echo "pwsh not found at '$PWSH' — set PWSH=/path/to/pwsh"; exit 1; }

echo "==> stopping any running runner"
pkill -f Start-IamRunner 2>/dev/null || true
sleep 1

echo "==> fetching manifest from $APP"
manifest="$(curl -fsS --max-time 30 "${HDR[@]}" "$APP/api/runner/manifest")" \
  || { echo "could not reach $APP/api/runner/manifest — is the dev server up at that address?"; exit 1; }
files="$(printf '%s' "$manifest" | python3 -c 'import sys,json;[print(f) for f in json.load(sys.stdin)["files"]]')"
build="$(printf '%s' "$manifest" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("buildId",""))')"
echo "    build $build — $(printf '%s\n' "$files" | grep -c .) files"

echo "==> downloading into $DIR"
mkdir -p "$DIR"
while IFS= read -r rel; do
  [ -z "$rel" ] && continue
  dest="$DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  enc="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$rel")"
  curl -fsS --max-time 60 "${HDR[@]}" "$APP/api/runner/file?path=$enc" -o "$dest" \
    || { echo "failed to download $rel"; exit 1; }
  echo "    $rel"
done <<< "$files"

echo "==> launching runner ($AGENT)"
args=(-NoProfile -ExecutionPolicy Bypass -File "$DIR/Start-IamRunner.ps1" -AppUrl "$APP" -AgentId "$AGENT")
[ -n "$TOKEN" ] && args+=(-ApiToken "$TOKEN")
nohup "$PWSH" "${args[@]}" > "$DIR/runner.log" 2>&1 &
pid=$!
echo "    started detached (pid $pid). Log: $DIR/runner.log"
sleep 2
echo "==> tailing the log (Ctrl-C to stop watching — the runner keeps running):"
tail -f "$DIR/runner.log"
