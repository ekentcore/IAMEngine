#!/usr/bin/env bash
# Show the open PRs, then merge one by number.
#
#   ./scripts/prs.sh            list open PRs (number, title, draft/ready, CI, mergeable)
#   ./scripts/prs.sh 56         merge PR 56 (squash, delete the branch, un-draft it first if needed)
#   ./scripts/prs.sh 56 --yes   skip the confirmation prompt
#   ./scripts/prs.sh --tidy     show which finished Claude worktrees can be retired (--yes to do it)
#   ./scripts/prs.sh --tidy --stale
#                               also retire LOCKED worktrees left behind by dead sessions — only when
#                               clean, fully merged, and no process is inside them (--yes to do it)
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
#   - IN USE   -> a process is inside the directory (lsof). LIVE session. Never touched, ever.
#   - LOCKED   -> a session created it. On its own this does NOT mean a session is still running — a
#                 dead session leaves it locked forever — so --stale will retire one when it is also
#                 clean, merged and not in use. Without --stale, left alone.
#   - DIRTY    -> uncommitted work. Never touched.
#   - UNMERGED -> commits not on main yet. Never touched (a squash-merge still counts as merged,
#                 because we compare the TREE, not the commits).
if [[ "$PR" == "--tidy" ]]; then
  # --stale also retires LOCKED worktrees, but only when they are provably abandoned. "Locked" just
  # means a session created it; it says nothing about whether that session is still alive, so a dead
  # session's worktree stays locked forever and plain --tidy skips it for good (13 had accumulated).
  # The honest liveness test is whether a process is actually IN the directory (lsof), not the lock —
  # and it must ALSO be clean and fully merged, so nothing can be lost either way.
  STALE=""
  DO_IT=""
  for arg in "${@:2}"; do
    [[ "$arg" == "--stale" ]] && STALE="yes"
    [[ "$arg" == "--yes" ]] && DO_IT="--yes"
  done
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

    # A worktree with a process actually inside it is LIVE — never touch it, locked or not. This is the
    # only reliable signal; the lock flag only tells you a session created it, not that one is running.
    # `|| true`: lsof exits NON-ZERO when it finds nothing, which under `set -e -o pipefail` would kill
    # the script at this assignment — i.e. it would die on exactly the worktrees we want to retire.
    IN_USE=$({ lsof +D "$path" 2>/dev/null || true; } | tail -n +2 | wc -l | tr -d ' ')
    if [[ "${IN_USE:-0}" != "0" ]]; then
      echo "  keep   $short  (IN USE — a session is working in it right now)"; KEPT=$((KEPT+1)); continue
    fi
    if [[ -n "$locked" && -z "$STALE" ]]; then
      echo "  keep   $short  (locked — pass --stale to retire it if its work is merged)"; KEPT=$((KEPT+1)); continue
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
      # A locked worktree needs --force to come out. Safe HERE and only here: we have already proved it
      # is clean, fully merged, and that no process is inside it.
      git worktree unlock "$path" >/dev/null 2>&1 || true
      git worktree remove "$path" 2>/dev/null || git worktree remove --force "$path"
      git branch -D "$short" >/dev/null 2>&1 || true
      echo "  gone   $short"
    else
      echo "  would remove   $short  ($path)${locked:+  [locked, but abandoned]}"
    fi
    GONE=$((GONE+1))
  done
  git worktree prune
  echo
  [[ "$DO_IT" == "--yes" ]] || echo "dry run — re-run with:  $0 --tidy${STALE:+ --stale} --yes"
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
