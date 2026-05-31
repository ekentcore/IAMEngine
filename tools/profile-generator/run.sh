#!/usr/bin/env bash
# Chain the two stages: extract (Python) -> IR -> assemble (TypeScript) -> drafts.
# Selection flags (--client/--family/--slice/--all/--include-parked) go to extract;
# --diff-curated and --report-only go to assemble. Examples:
#   ./run.sh --slice 8 --diff-curated
#   ./run.sh --client "Six One"
#   ./run.sh --all
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/.venv/bin/python"

if [[ ! -x "$PY" ]]; then
  echo "venv missing — run: python3 -m venv .venv && .venv/bin/pip install -r extract/requirements.txt" >&2
  exit 2
fi

extract_args=()
assemble_args=()
for a in "$@"; do
  case "$a" in
    --diff-curated|--report-only) assemble_args+=("$a") ;;
    *) extract_args+=("$a") ;;
  esac
done

echo "→ extract"
( cd "$HERE/extract" && "$PY" -m kbgen.cli ${extract_args[@]+"${extract_args[@]}"} )

echo "→ assemble"
( cd "$HERE/assemble" && npm run --silent assemble -- ${assemble_args[@]+"${assemble_args[@]}"} )
