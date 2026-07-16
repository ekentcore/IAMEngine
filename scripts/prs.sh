#!/usr/bin/env bash
# Show the open PRs, then merge one by number.
#
#   ./scripts/prs.sh            list open PRs (number, title, draft/ready, CI, mergeable)
#   ./scripts/prs.sh 56         merge PR 56 (squash, delete the branch, un-draft it first if needed)
#   ./scripts/prs.sh 56 --yes   skip the confirmation prompt
#   ./scripts/prs.sh --all      list every ready PR that --all would merge (dry run)
#   ./scripts/prs.sh --all --yes
#                               merge them all oldest-first, catching each up to main as its turn
#                               comes, then sweep finished worktrees. Drafts are left alone — a draft
#                               is work-in-progress on purpose.
#   ./scripts/prs.sh --tidy     show which finished Claude worktrees can be retired (--yes to do it)
#   ./scripts/prs.sh --tidy --stale
#                               also retire LOCKED worktrees left behind by dead sessions — only when
#                               clean, fully merged, and no process is inside them (--yes to do it)
#
# BEFORE merging, the script CATCHES THE PR'S BRANCH UP TO MAIN: it merges origin/main into the
# branch locally and pushes. main moves while a PR is open, and GitHub then reports CONFLICTING and
# refuses — where the old answer was "here are three commands, go do it yourself", on every such PR.
# Most of those are not real disagreements; the two sides changed different things and git merges them
# without a murmur. Nobody was asking git. Two things make the LOCAL merge matter, not just the merge:
#   - .gitattributes merge drivers (e.g. `merge=union` on the changelog registry) are a LOCAL git
#     feature. GitHub's merge ignores them, so a conflict git settles silently here is still a hard
#     CONFLICTING there. This is the only place those drivers ever run.
#   - a real conflict gets rolled back and handed to you with the file list, instead of a merge that
#     half-happened on a server.
# It never resolves a conflict for you, and never touches a worktree with uncommitted work. Opt out
# with PRS_NO_BRANCH_SYNC=1.
#
# After a successful merge the script SYNCS THE LOCAL main checkout: it fast-forwards main and runs
# `npm install` (in web/ and runner/browser/), so the next `next dev` compile can't die on a package
# that landed in a merged PR but was never installed here — the "Module not found: Can't resolve
# 'marked'" class of failure, which in dev cascades 500s across every route (heartbeat/claim included).
# This is SAFE by construction: it only touches the main checkout when that checkout is on main AND
# clean; otherwise it prints what to run by hand and changes nothing. Opt out for one run with
# PRS_NO_SYNC=1. It still does NOT touch the database — after a merge that ships a migration you run
# `npx prisma migrate deploy` from web/ yourself (see the end).
set -euo pipefail

command -v gh >/dev/null || { echo "gh CLI not found — brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not logged in — run: gh auth login"; exit 1; }

# After a merge, bring the LOCAL main checkout in step with what just shipped: fast-forward main and
# install any new dependencies. The pain this removes: a PR adds a dependency (e.g. `marked`), it lands
# on main, someone pulls, but nobody runs `npm install` — then the dev server's next compile fails to
# resolve the module and, because a resolution error takes down the whole dev module graph, every route
# starts returning 500 (including /api/agents/heartbeat, so the fleet stalls too).
#
# Guarded so it can never surprise you: acts ONLY when the main checkout is on `main` and has no
# uncommitted changes; otherwise it just prints the exact commands and touches nothing. `npm install`
# is a near-noop when node_modules already matches the lockfile, so running it after every pull is
# cheap and makes "a dep shipped but was never installed here" impossible. Opt out with PRS_NO_SYNC=1.
sync_local_after_merge() {
  [[ "${PRS_NO_SYNC:-}" == "1" ]] && { echo "sync: skipped (PRS_NO_SYNC=1)."; return 0; }
  local root; root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  [[ -z "$root" ]] && return 0
  local branch; branch=$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
  if [[ "$branch" != "main" ]]; then
    echo "sync: the checkout here is on '${branch:-a detached HEAD}', not main — not pulling. To refresh by hand:"
    echo "        cd \"$root\" && git checkout main && git pull --ff-only && (cd web && npm install)"
    return 0
  fi
  # Only TRACKED uncommitted changes block us — `--untracked-files=no` ignores untracked files (this
  # repo always carries some, e.g. .claude/ and stray CSVs). A `git pull --ff-only` doesn't care about
  # untracked files, so counting them as "dirty" wrongly skipped the pull + install on every merge —
  # which is why a freshly-merged dependency (mammoth/turndown) never got installed here.
  if [[ -n "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
    echo "sync: main has uncommitted (tracked) changes — not pulling. Refresh once it's clean:"
    echo "        cd \"$root\" && git pull --ff-only && (cd web && npm install)"
    return 0
  fi
  echo "sync: fast-forwarding main…"
  if ! git -C "$root" pull --ff-only -q; then
    echo "sync: could not fast-forward main (diverged from origin?) — pull it by hand, then \`npm install\`."
    return 0
  fi
  # Install deps wherever we ship a package.json. Unconditional after a pull: it's a fast no-op when
  # nothing changed, and guarantees a freshly-merged dependency is actually present on disk.
  local d
  for d in web runner/browser; do
    if [[ -f "$root/$d/package.json" ]]; then
      echo "sync: npm install in ${d}…"
      ( cd "$root/$d" && npm install --no-audit --no-fund >/dev/null ) \
        && echo "sync: $d dependencies up to date." \
        || echo "sync: npm install in $d FAILED — run \`(cd $d && npm install)\` by hand."
    fi
  done
  echo "sync: local checkout is current. Restart the dev server to pick up app changes; a merged runner"
  echo "      file is served from disk, so agents auto-update on their next heartbeat (no rebuild)."
}

# Bring the PR's branch up to date with main BEFORE asking GitHub to merge it.
#
# main moves while a PR is open. The moment the PR touches anything main also touched, GitHub reports
# CONFLICTING and the merge fails — and the script's whole answer was "here are three commands, go do
# it yourself", on every such PR. Most of those are not real disagreements: the two sides changed
# different things and git merges them without a murmur. Only nobody was asking git.
#
# Doing the merge LOCALLY is not just a convenience — it is the only way our merge drivers run at all.
# .gitattributes (`merge=union` on the changelog registry) is a LOCAL git feature: GitHub's
# server-side merge ignores it completely, so a conflict git resolves silently here is still a hard
# CONFLICTING there. Syncing locally and pushing is what makes those drivers do their job.
#
# Safe by construction. On a REAL conflict it aborts, leaves the branch byte-for-byte as it was, and
# prints the files — it never resolves a conflict for you, because "both sides edited this line" needs
# a human who knows which is right. It touches a worktree only when that worktree is clean. Opt out of
# the whole thing with PRS_NO_BRANCH_SYNC=1.
#
# Returns non-zero when the merge cannot proceed, so the caller stops BEFORE un-drafting the PR.
sync_branch_with_main() {
  local branch="$1"
  [[ "${PRS_NO_BRANCH_SYNC:-}" == "1" ]] && { echo "branch sync: skipped (PRS_NO_BRANCH_SYNC=1)."; return 0; }
  [[ -z "$branch" ]] && return 0
  git fetch -q origin main 2>/dev/null || { echo "branch sync: could not fetch origin/main — leaving the branch alone."; return 0; }

  git rev-parse -q --verify "origin/$branch" >/dev/null 2>&1 || {
    echo "branch sync: no origin/$branch to sync — leaving it alone."; return 0; }

  # Nothing to do when the branch already contains main. This is the common case, so stay quiet.
  if git merge-base --is-ancestor origin/main "origin/$branch" 2>/dev/null; then return 0; fi

  echo "branch sync: '$branch' is behind main — merging origin/main into it here, not on GitHub"
  echo "             (a local merge is also the only place .gitattributes merge drivers apply)"

  # Do the whole thing in a throwaway worktree, DETACHED at ORIGIN's view of the branch, and push the
  # result straight to the branch ref. Deliberately never touches a local branch or an existing
  # worktree:
  #   - the PR is what GitHub has. A local branch may be stale, or ahead with commits that were never
  #     pushed and so aren't in the PR at all; merging from either would sync the wrong tree.
  #   - a session's worktree is not ours to rewrite. Checking the branch out here would also fail
  #     outright whenever a worktree already holds it, which is the normal case.
  # The earlier version of this borrowed the branch and did `checkout -B "$branch" "origin/$branch"`
  # to make it pushable — which force-resets the local branch and would DISCARD unpushed commits.
  # Detached + `push HEAD:refs/heads/<branch>` needs no local branch to exist at all.
  local tmp rc=0
  tmp=$(mktemp -d) || { echo "branch sync: could not make a temp dir — skipping."; return 0; }
  if ! git worktree add -q --detach "$tmp" "origin/$branch" 2>/dev/null; then
    rm -rf "$tmp"; echo "branch sync: could not check out origin/$branch — leaving it alone."; return 0
  fi

  if git -C "$tmp" merge --no-edit -m "Merge origin/main into $branch (prs.sh: catch the PR up before merging)" origin/main >/dev/null 2>&1; then
    echo "branch sync: merged cleanly — pushing"
    if git -C "$tmp" push -q origin "HEAD:refs/heads/$branch" 2>/dev/null; then
      echo "branch sync: '$branch' now contains main."
      # GitHub needs a moment to recompute mergeability after the push; merging against a stale
      # CONFLICTING verdict would fail for no reason at all.
      local m
      for _ in 1 2 3 4 5 6; do
        m=$(gh pr view "$PR" --json mergeable -q .mergeable 2>/dev/null || echo UNKNOWN)
        [[ "$m" == "UNKNOWN" ]] || break
        sleep 2
      done
    else
      echo "branch sync: push FAILED (no permission, or the branch moved under us) — by hand:"
      echo "               gh pr checkout $PR && git fetch origin main && git merge origin/main && git push"
      rc=1
    fi
  else
    local conflicts; conflicts=$(git -C "$tmp" diff --name-only --diff-filter=U 2>/dev/null)
    echo
    echo "branch sync: main and this PR changed the same lines. Git can't resolve that, and neither"
    echo "             should a script — it needs someone who knows which side is right."
    echo "  conflicting:"
    echo "$conflicts" | sed 's/^/    /'
    echo "  resolve it with:"
    echo "    gh pr checkout $PR && git fetch origin main && git merge origin/main"
    echo "    # fix the files, then:  git commit && git push  — and re-run this script."
    echo
    echo "  (nothing was pushed — the branch on GitHub is exactly as it was)"
    rc=1
  fi

  # The merge happened in a scratch worktree, so cleanup is the whole rollback: nothing was pushed on
  # the failure path, and no branch or worktree of anyone's was ever written to.
  git worktree remove --force "$tmp" 2>/dev/null || rm -rf "$tmp"
  git worktree prune 2>/dev/null || true
  return $rc
}

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

# ./scripts/prs.sh --all — merge every ready, non-conflicting PR, oldest first, then tidy.
#
# "Ready" means NOT a draft — a draft is deliberately work-in-progress. CONFLICTING PRs are now
# INCLUDED rather than filtered out: each merge recurses into the single-PR path, which first merges
# main into the branch locally, and most "conflicts" are just a stale branch that git reconciles
# without help. One that genuinely disagrees with main fails that sync, returns non-zero, and is
# skipped here exactly as before — so including them can only add merges, never break one.
#
# This also dissolves the catch a hand-written `for` loop misses: every squash-merge moves main, so a
# PR that is mergeable now can be in conflict by the time its turn comes. That PR used to be skipped;
# now its turn begins by catching it up to the main the previous merge just created.
if [[ "$PR" == "--all" ]]; then
  DO_IT=""
  for arg in "${@:2}"; do [[ "$arg" == "--yes" ]] && DO_IT="--yes"; done
  git fetch -q origin main

  # Every open, non-draft PR, oldest first. (Newline-separated; iterated with word-splitting, which
  # keeps this working on the stock macOS bash 3.2 that has no `mapfile`.)
  READY=$(gh pr list --state open --json number,isDraft \
    --jq 'map(select(.isDraft == false)) | sort_by(.number) | .[].number')

  if [[ -z "$READY" ]]; then
    echo "No ready PRs to merge (drafts are left alone — see: $0)."
    exit 0
  fi

  echo "Ready PRs (oldest first; any behind main are caught up first):"
  gh pr list --state open --json number,title,isDraft,mergeable \
    --jq 'map(select(.isDraft == false)) | sort_by(.number) | .[] | "  #\(.number)  \(.title)\(if .mergeable == "CONFLICTING" then "   [behind main — will try to catch it up]" else "" end)"'
  echo

  if [[ "$DO_IT" != "--yes" ]]; then
    echo "dry run — re-run with:  $0 --all --yes"
    exit 0
  fi

  MERGED=""; SKIPPED=""; MIG_PRS=""
  for n in $READY; do
    # No mergeability pre-check any more: the single-PR path catches the branch up to main first, so a
    # CONFLICTING verdict here would be answering a question we are about to change the answer to. A
    # PR that truly disagrees with main fails that sync and lands in the skip below.

    # Note a migration BEFORE merging, so the end-of-run summary can list every DB deploy still owed.
    if gh pr diff "$n" --name-only 2>/dev/null | grep -q 'prisma/migrations/.*\.sql$'; then
      MIG_PRS="$MIG_PRS #$n"
    fi

    echo "──────── merging #$n ────────"
    # PRS_IN_ALL=1: the recursive single-PR call skips its own local sync so we don't pull+install once
    # per merge — the whole batch is synced ONCE after the loop instead.
    if PRS_IN_ALL=1 "$0" "$n" --yes; then
      MERGED="$MERGED #$n"
    else
      echo "  skip  #$n  (left open — see the reason above; a real conflict needs a human)"
      SKIPPED="$SKIPPED #$n"
    fi
    echo
  done

  echo "════════ done ════════"
  echo "merged: ${MERGED:- none}"
  echo "skipped:${SKIPPED:- none}"
  echo

  echo "sweeping finished worktrees…"
  "$0" --tidy --stale --yes || true

  # One local sync for the whole batch (the per-merge calls were suppressed via PRS_IN_ALL).
  if [[ -n "$MERGED" ]]; then
    echo
    sync_local_after_merge
  fi

  if [[ -n "$MIG_PRS" ]]; then
    cat <<NEXT

One or more merged PRs shipped a DB migration ($MIG_PRS). The database still needs them:

  cd "\$(git rev-parse --show-toplevel)/web"
  git checkout main && git pull
  npx prisma migrate deploy    # forward-only. NEVER \`migrate dev\` — that resets the DB.
  npx prisma generate

Then restart the dev server so it picks up the regenerated client.
NEXT
  fi
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

BRANCH=$(gh pr view "$PR" --json headRefName -q .headRefName)

# Catch main up FIRST — before un-drafting, before retiring the worktree. A sync that can't finish
# must leave the PR exactly as it found it (a PR left un-drafted by a merge that never happened is a
# lie about its state), and its worktree still standing.
sync_branch_with_main "$BRANCH" || exit 1

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

# Bring the local checkout in step (fast-forward main + npm install), unless this run is a --all batch,
# which syncs once at the end instead of after every single merge.
if [[ "${PRS_IN_ALL:-}" != "1" ]]; then
  echo
  sync_local_after_merge
fi

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
