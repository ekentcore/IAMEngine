# The self-healing fix lane

Hand a failing run-log line to a headless Claude Code session that diagnoses the failure, patches
the code in an **isolated git worktree**, and opens a **draft pull request**. A human always
reviews and merges — the lane proposes fixes; it never ships them.

## How it works

1. **Trigger** — on `/runs`, every open error/warning row has **🤖 Fix with Claude** (v2: in the
   row's Actions menu; classic: an inline button). It POSTs the line's fingerprint, a short title
   (`<systemKey>: <first message line>`) and the full error text to `POST /api/fix-tasks`
   (guarded to `case.dispatch`). Optionally, the **auto-trigger** (below) files tasks by itself.
2. **Queue** — a `FixTask` row is created (`queued`) and the detached worker
   `scripts/claude-fix.mjs` is spawned (survives a web-server restart). The row's status chip on
   the run-log row polls every 5s: queued → fixing → PR link / no change / failed.
3. **Fix** — the worker adds a throwaway worktree at `/tmp/iam-fix-<id>` on branch
   `claude-fixes/<id>` and runs `claude -p` headlessly with the failure context: find root cause
   in `web/` or `runner/`, make the minimal fix, run `npx tsc --noEmit` + relevant tests, commit,
   reply with a one-paragraph diagnosis.
4. **PR** — if (and only if) Claude committed a change, the branch is pushed and
   `gh pr create --draft` opens the PR with the diagnosis in the body. The task becomes
   `opened_pr` with the URL; otherwise `no_change`. The diagnosis (+ cost) is stored in
   `FixTask.log` either way.
5. **Cleanup** — the temp worktree is always removed (and the local branch deleted if it was
   never pushed), success or failure.

## Guardrails

This is powerful automation, so the guardrails are the feature:

- **Worktree isolation** — the fixer never touches your checkout or `main`; it works in a
  throwaway worktree under `/tmp`, removed in a `finally` whatever happens.
- **Allowlisted tools** — the headless session can read/edit files and run only
  `npm test`, `npx tsc`, and `git diff/add/commit`. No push, no `gh`, no arbitrary shell.
- **Turn + time caps** — `--max-turns 25` and a 15-minute hard timeout (the child is killed and
  the task marked `failed: timeout`).
- **No repo hooks/skills inside the fixer** — the worker passes `--bare` (or
  `--settings '{"disableAllHooks":true}'` on older CLIs), so nothing in the repo's Claude config
  runs during the automated session.
- **Draft PR only** — the worker never merges and never force-pushes. Review the diff like any
  other PR; close it if the diagnosis is wrong.
- **One task per fingerprint** — `POST /api/fix-tasks` refuses (409) while a task for the same
  fingerprint is queued/running, so a repeated failure can't fan out into parallel fixers.
- **Auto mode is opt-in and rate-limited** — see below. Default off.

## Auto-trigger (opt-in)

Settings → **Self-healing fixes** → "Automatically hand repeated failures to Claude" (the
`autoFix` app setting, default **off**). When on, the heartbeat sweep
(`sweepAutoFix` in `web/lib/jobs/procurement-watch.ts`) picks up unresolved **failed** lines whose
identical fingerprint has recurred **3+ times**, and files at most **one** new FixTask per sweep
(`requestedBy: system:auto-fix`). A fingerprint that ever had a FixTask is never auto-queued
again — no retry loops. The toggle copy says it plainly: this only proposes fixes; **a human
still merges every PR**.

## Requirements

On the host that runs the web app:

- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code` (or the native installer),
  then `claude` must be on the PATH of the web-server process and authenticated
  (`claude login`, or `ANTHROPIC_API_KEY` in its environment).
- **GitHub CLI** — `gh auth login` with permission to push branches and open PRs on this repo.
- **Git remote** — `origin` must accept pushes of `claude-fixes/*` branches.
- The worker reads `DATABASE_URL` from `web/.env` and Prisma from `web/node_modules`, both
  resolved relative to the script's own checkout — no extra install step.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Task stuck `queued`, no chip movement | The spawn failed silently (rare) or the host lacks `node` on PATH for the detached child. Run it by hand: `node scripts/claude-fix.mjs --task <id>` and read stderr. |
| `failed` with "the `claude` CLI is not installed" | Install/auth the CLI for the *web server's* user, not just your shell. |
| `failed: timeout` | The session exceeded 15 minutes. The context may be too vague — check `FixTask.log`, fix by hand, or re-trigger with a cleaner error line. |
| `no_change` | Claude judged the failure environmental (credentials, vendor outage, seats) or couldn't find the root cause — its reasoning is in `FixTask.log`. That's the guardrail working: no speculative commits. |
| PR push fails | `gh auth status`; confirm the repo remote and that branch protection allows `claude-fixes/*`. |
| Stale worktree at `/tmp/iam-fix-*` | Only possible after a hard kill: `git worktree remove --force /tmp/iam-fix-<id>` from the main checkout. |

Fix-task rows live in the `FixTask` table; every creation is audited (`fixtask.create`, actor =
the operator or `system:auto-fix`).
