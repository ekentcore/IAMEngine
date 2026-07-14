#!/usr/bin/env bash
# Show the open PRs, then merge one by number.
#
#   ./scripts/prs.sh            list open PRs (number, title, draft/ready, CI, mergeable)
#   ./scripts/prs.sh 56         merge PR 56 (squash, delete the branch, un-draft it first if needed)
#   ./scripts/prs.sh 56 --yes   skip the confirmation prompt
#   ./scripts/prs.sh --tidy     show which finished Claude worktrees can be retired (--yes to do it)
#
# Merging only ever touches GitHub. It does NOT touch the database — after a merge that ships a
# migration you still have to run `npx prisma migrate deploy` from web/ yourself (see the end).
set -euo pipefail

command -v gh >/dev/null || { echo "gh CLI not found — brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not logged in — run: gh auth login"; exit 1; }

PR="${1:-}"

# ./scripts/prs.sh --tidy — retire finished worktrees.
#
# Every Claude session builds its PR in a worktree under .claude/worktrees/ and they pile up (17 of
# them by 2026-07-14). Each one keeps a branch checked out, which is what makes `gh pr merge
# --delete-branch` fail with "cannot delete branch X used by worktree at ...". This clears the ones
# that are genuinely finished, and refuses to touch anything else:
#   - LOCKED   -> another session may still be using it. Never touched.
#   - DIRTY    -> uncommitted work. Never touched.
#   - UNMERGED -> commits not on main yet. Never touched (a squash-merge still counts as merged,
#                 because we compare the TREE, not the commits).
if [[ "$PR" == "--tidy" ]]; then
  DO_IT="${2:-}"
  git fetch -q origin main
  KEPT=0; GONE=0
  # -P is GNU-only; read the porcelain and pair up path/branch/locked ourselves.
  git worktree list --porcelain | awk '
    /^worktree /  { if (path != "") print path "\t" branch "\t" locked; path = substr($0, 10); branch = ""; locked = "" }
    /^branch /    { branch = substr($0, 8) }
    /^locked/     { locked = "locked" }
    END           { if (path != "") print path "\t" branch "\t" locked }' |
  while IFS=$'\t' read -r path branch locked; do
    # Skip the main checkout itself, and anything without a branch.
    [[ "$path" == "$(git rev-parse --show-toplevel)" ]] && continue
    [[ "$path" == */.claude/worktrees/* ]] || continue
    [[ -z "$branch" ]] && continue
    short="${branch#refs/heads/}"

    if [[ -n "$locked" ]]; then
      echo "  keep   $short  (locked — another session may be using it)"; KEPT=$((KEPT+1)); continue
    fi
    if [[ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]]; then
      echo "  keep   $short  (uncommitted changes)"; KEPT=$((KEPT+1)); continue
    fi
    # Is its work already on main? A SQUASH-merge rewrites the commits, so `git branch --merged` says
    # "no" even when every line has shipped. Compare the trees instead: if the branch's tree is
    # identical to main's, or it has no commits main doesn't already contain, it is done.
    AHEAD=$(git rev-list --count "origin/main..$branch" 2>/dev/null || echo 0)
    SAME_TREE=$([[ "$(git rev-parse "$branch^{tree}" 2>/dev/null)" == "$(git rev-parse origin/main^{tree})" ]] && echo yes || echo no)
    if [[ "$AHEAD" != "0" && "$SAME_TREE" == "no" ]]; then
      echo "  keep   $short  ($AHEAD commit(s) not on main)"; KEPT=$((KEPT+1)); continue
    fi

    if [[ "$DO_IT" == "--yes" ]]; then
      git worktree remove "$path" 2>/dev/null || git worktree remove --force "$path"
      git branch -D "$short" >/dev/null 2>&1 || true
      echo "  gone   $short"
    else
      echo "  would remove   $short  ($path)"
    fi
    GONE=$((GONE+1))
  done
  git worktree prune
  echo
  [[ "$DO_IT" == "--yes" ]] || echo "dry run — re-run with:  $0 --tidy --yes"
  exit 0
fi

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

# --- release the branch BEFORE the merge tries to delete it ---------------------------------------
# Every PR from a Claude session is built in a git worktree under .claude/worktrees/, and that worktree
# keeps its branch CHECKED OUT. Git flatly refuses to delete a branch a worktree is using, so
# `gh pr merge --delete-branch` merged fine and then died on the local cleanup:
#
#   failed to delete local branch X: cannot delete branch 'X' used by worktree at '...'
#
# The merge had already happened, so it was noise — but noise on every single merge. Retire the
# worktree first and the delete just works.
BRANCH=$(gh pr view "$PR" --json headRefName -q .headRefName)
DELETE_BRANCH="--delete-branch"
if [[ -n "$BRANCH" ]]; then
  # Which worktree (if any) has this branch checked out?
  WT=$(git worktree list --porcelain | awk -v want="refs/heads/$BRANCH" '
    /^worktree /  { path = substr($0, 10) }
    /^branch /    { if (substr($0, 8) == want) { print path; exit } }')
  if [[ -n "$WT" ]]; then
    LOCKED=$(git worktree list --porcelain | awk -v p="worktree $WT" '$0 == p { f=1; next } /^worktree /{ f=0 } f && /^locked/ { print "locked" }')
    if [[ -n "$LOCKED" ]]; then
      # A LOCKED worktree may have a Claude session live inside it right now — force-removing it would
      # pull the rug out from under a running session. Merge, keep the branch, and let the human decide.
      echo "NOTE: worktree $WT is LOCKED (a session may still be running in it) and holds '$BRANCH'."
      echo "      Merging, but KEEPING the local branch. When that session is done:"
      echo "        $0 --tidy --yes"
      echo
      DELETE_BRANCH=""
    elif [[ -n "$(git -C "$WT" status --porcelain 2>/dev/null)" ]]; then
      # Uncommitted work in there — never throw it away behind the user's back. Merge, but keep the
      # branch so nothing is stranded, and say exactly what to do.
      echo "NOTE: worktree $WT has uncommitted changes and is holding branch '$BRANCH'."
      echo "      Merging, but KEEPING the local branch. Deal with the worktree, then:"
      echo "        git worktree remove $WT && git branch -d $BRANCH"
      echo
      DELETE_BRANCH=""
    else
      echo "retiring the worktree holding '$BRANCH': $WT"
      git worktree remove "$WT"
    fi
  fi
fi

gh pr merge "$PR" --squash $DELETE_BRANCH
git worktree prune

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
