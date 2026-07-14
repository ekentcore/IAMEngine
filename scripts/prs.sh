#!/usr/bin/env bash
# Show the open PRs, then merge one by number.
#
#   ./scripts/prs.sh          list open PRs (number, title, draft/ready, CI, mergeable)
#   ./scripts/prs.sh 56       merge PR 56 (squash, delete the branch, un-draft it first if needed)
#   ./scripts/prs.sh 56 --yes skip the confirmation prompt
#
# Merging only ever touches GitHub. It does NOT touch the database — after a merge that ships a
# migration you still have to run `npx prisma migrate deploy` from web/ yourself (see the end).
set -euo pipefail

command -v gh >/dev/null || { echo "gh CLI not found — brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not logged in — run: gh auth login"; exit 1; }

PR="${1:-}"

if [[ -z "$PR" ]]; then
  echo "Open pull requests:"
  echo
  gh pr list --state open --json number,title,isDraft,statusCheckRollup,mergeable \
    --template '{{range .}}{{printf "  #%-4v " .number}}{{if .isDraft}}[draft] {{else}}[ready] {{end}}{{printf "%-62.62v" .title}} {{if eq .mergeable "CONFLICTING"}}CONFLICTS{{else}}ok{{end}}
{{end}}'
  echo
  echo "Merge one with:  $0 <number>"
  exit 0
fi

[[ "$PR" =~ ^[0-9]+$ ]] || { echo "expected a PR number, got: $PR"; exit 1; }

# Show what is about to be merged, including whether it carries a migration.
gh pr view "$PR" --json number,title,isDraft,mergeable,headRefName \
  --template 'PR #{{.number}}  {{.title}}
branch: {{.headRefName}}   draft: {{.isDraft}}   mergeable: {{.mergeable}}
'
MIGRATIONS=$(gh pr diff "$PR" --name-only | grep 'prisma/migrations/.*\.sql$' || true)
if [[ -n "$MIGRATIONS" ]]; then
  echo "carries a DB migration:"
  echo "$MIGRATIONS" | sed 's/^/  /'
  echo
fi

if [[ "${2:-}" != "--yes" ]]; then
  read -r -p "Squash-merge PR #$PR into main? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "aborted"; exit 0; }
fi

# A draft cannot be merged — mark it ready first. Harmless if it already is.
gh pr ready "$PR" >/dev/null 2>&1 || true
gh pr merge "$PR" --squash --delete-branch

echo
echo "merged."
if [[ -n "$MIGRATIONS" ]]; then
  cat <<'NEXT'

This PR shipped a migration, so the database still needs it:

  cd "$(git rev-parse --show-toplevel)/web"
  git checkout main && git pull
  npx prisma migrate deploy    # forward-only. NEVER `migrate dev` — that resets the DB.
  npx prisma generate

Then restart the dev server so it picks up the regenerated client.
NEXT
fi
