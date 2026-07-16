#!/usr/bin/env bash
# Tests prs.sh's sync_branch_with_main against a REAL git repo (a throwaway origin + clone), by
# lifting the function straight out of the script — so it tests the shipped code, not a copy.
#
#   ./scripts/tests/prs-branch-sync.test.sh
#
# Why this exists: the function force-pushes nothing and merges everything, which is a bad combination
# to get wrong. It earned its keep immediately — the first version borrowed the branch and ran
# `git checkout -B "$branch" "origin/$branch"` to make it pushable, which RESETS the local branch and
# silently discards commits that were never pushed. Case 6 is that bug. The current version works
# detached from origin/<branch> and pushes HEAD:refs/heads/<branch>, touching no local branch at all.
#
# Cases: behind-main (clean merge) / a real same-line conflict (must roll back and push NOTHING) /
# .gitattributes merge=union resolving a registry collision (the thing GitHub's own merge cannot do) /
# already-up-to-date (silent) / branch not checked out anywhere / local unpushed commits survive /
# no scratch worktree leaked.
set -uo pipefail
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)/prs.sh}"
[ -f "$SRC" ] || { echo "cannot find prs.sh at $SRC"; exit 1; }
: "${CLAUDE_JOB_DIR:=$(mktemp -d)}"
T="$(mktemp -d)/synctest"; rm -rf "$T"; mkdir -p "$T"; cd "$T"
mkdir -p bin; printf '#!/bin/sh\necho MERGEABLE\n' > bin/gh; chmod +x bin/gh
export PATH="$T/bin:$PATH"
git init -q --bare origin.git; git clone -q origin.git work 2>/dev/null; cd work
git config user.email t@t; git config user.name t
printf 'line1\nline2\nline3\n' > shared.txt
printf 'export { entry as alpha } from "./alpha";\n' > registry.ts
printf 'registry.ts merge=union\n' > .gitattributes
git add -A; git commit -qm base; git branch -M main; git push -qu origin main
eval "$(sed -n '/^sync_branch_with_main() {/,/^}$/p' "$SRC")"
PR=1
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (want '$3', got '$2')"; fail=$((fail+1)); fi; }

echo "== 1: behind main, non-overlapping =="
git checkout -qb featA; printf 'new\n' > a.txt; git add -A; git commit -qm A; git push -qu origin featA
git checkout -q main; printf 'line1\nline2\nline3\nline4-main\n' > shared.txt; git commit -qam m1; git push -q
sync_branch_with_main featA >/tmp/o1 2>&1; rc=$?
check "returns 0" "$rc" "0"; git fetch -q origin
check "origin/featA contains main" "$(git merge-base --is-ancestor origin/main origin/featA && echo yes || echo no)" "yes"

echo "== 2: real conflict, same line =="
git checkout -q main; git pull -q
git checkout -qb featB; printf 'line1\nBRANCH\nline3\nline4-main\n' > shared.txt; git commit -qam B; git push -qu origin featB
git checkout -q main; printf 'line1\nMAIN\nline3\nline4-main\n' > shared.txt; git commit -qam m2; git push -q
before=$(git rev-parse origin/featB)
sync_branch_with_main featB >/tmp/o2 2>&1; rc=$?
check "returns non-zero" "$([ $rc -ne 0 ] && echo yes || echo no)" "yes"
check "names the file" "$(grep -c 'shared.txt' /tmp/o2)" "1"
git fetch -q origin
check "origin/featB UNCHANGED (nothing pushed)" "$(git rev-parse origin/featB)" "$before"

echo "== 3: union driver resolves it =="
git checkout -q main; git pull -q
git checkout -qb featC; printf 'export { entry as alpha } from "./alpha";\nexport { entry as beta } from "./beta";\n' > registry.ts; git commit -qam C; git push -qu origin featC
git checkout -q main; printf 'export { entry as alpha } from "./alpha";\nexport { entry as gamma } from "./gamma";\n' > registry.ts; git commit -qam m3; git push -q
sync_branch_with_main featC >/tmp/o3 2>&1; rc=$?
check "returns 0" "$rc" "0"; git fetch -q origin
check "beta survives" "$(git show origin/featC:registry.ts | grep -c beta)" "1"
check "gamma survives" "$(git show origin/featC:registry.ts | grep -c gamma)" "1"

echo "== 4: up to date -> silent no-op =="
git checkout -q main; git pull -q; git checkout -qb featD; git push -qu origin featD
sync_branch_with_main featD >/tmp/o4 2>&1
check "prints nothing" "$(wc -c </tmp/o4 | tr -d ' ')" "0"

echo "== 5: branch NOT checked out anywhere (session worktree already retired) =="
git checkout -q main; git pull -q
git checkout -qb featE; printf 'e\n' > e.txt; git add -A; git commit -qm E; git push -qu origin featE
git checkout -q main; printf 'x\n' > x.txt; git add -A; git commit -qm m5; git push -q
git branch -D featE -q            # local branch gone entirely; only origin/featE exists
sync_branch_with_main featE >/tmp/o5 2>&1; rc=$?
check "returns 0 with no local branch at all" "$rc" "0"; git fetch -q origin
check "origin/featE contains main" "$(git merge-base --is-ancestor origin/main origin/featE && echo yes || echo no)" "yes"
check "did NOT create a local branch" "$(git rev-parse -q --verify featE >/dev/null 2>&1 && echo yes || echo no)" "no"

echo "== 6: local branch has UNPUSHED commits — they must survive (the -B bug) =="
git checkout -q main; git pull -q
git checkout -qb featF; printf 'f\n' > f.txt; git add -A; git commit -qm F; git push -qu origin featF
printf 'unpushed\n' > unpushed.txt; git add -A; git commit -qm "local only"   # never pushed
local_tip=$(git rev-parse featF)
git checkout -q main; printf 'y\n' > y.txt; git add -A; git commit -qm m6; git push -q
sync_branch_with_main featF >/tmp/o6 2>&1; rc=$?
check "returns 0" "$rc" "0"
check "local branch tip UNTOUCHED (unpushed commit intact)" "$(git rev-parse featF)" "$local_tip"
check "unpushed work still on disk" "$(git show featF:unpushed.txt 2>/dev/null | tr -d '\n')" "unpushed"

echo "== 7: no scratch worktrees leaked =="
check "worktree list is just the checkout" "$(git worktree list | wc -l | tr -d ' ')" "1"

echo; echo "passed: $pass   failed: $fail"; [ "$fail" = 0 ] || exit 1
