# The self-healing fix lane

Hand a failing run-log line to an LLM (any provider in the Settings registry) that reads the code
and produces a **structured fix proposal** — the file, the lines, and the exact before/after text —
which an operator reviews **on screen**. Applying a reviewed proposal patches an **isolated git
worktree**, runs the checks, and opens a **draft pull request**. A human always reviews and
merges — the lane proposes fixes; it never ships them.

## How it works

1. **Provider** — Settings → **LLM providers**: an extensible registry (presets for Claude,
   OpenAI, OpenRouter, Azure AI, Hugging Face; any OpenAI-compatible endpoint works). The API key
   is entered there, stored server-side, and only ever shown as its last 4 characters. The lane
   uses the **default** provider. A per-provider **Test** button does a 1-token call.
2. **Trigger** — on `/runs`, every open error/warning row has **🤖 Fix with AI** (v2: in the row's
   Actions menu, with a status chip beside it; classic + mobile: an inline button). It POSTs the
   line's fingerprint, a short title (`<systemKey>: <first message line>`) and the full error text
   to `POST /api/fix-tasks` (guarded to `case.dispatch`; 422 when no provider is configured).
   Optionally, the **auto-trigger** (below) files tasks by itself.
3. **Analyze** — a `FixTask` row is created (`queued`) and the detached worker
   `scripts/llm-fix.mjs --task <id>` is spawned (survives a web-server restart). It runs a
   READ-ONLY tool-calling session against the repo — `search_repo` (git grep) and `read_file`
   (bounded, secrets paths refused) — and must finish with one of two terminal tools:
   - `propose_fix` → the proposal (diagnosis + exact edits, each drift-validated against the
     current file) is stored on the row → status **`proposed`**;
   - `no_fix` → status **`no_change`** with the reasoning in `FixTask.log`.
   Caps: 20 tool turns, 10-minute wall clock. Any provider/HTTP/auth error → **`failed`** with
   the provider's error in the log — a broken key is never reported as "no change".
4. **Review** — the row's chip turns into **"fix ready — review"**. Clicking it opens the review
   panel: the diagnosis, then every edit's file, line range and before/after text. From there:
   **Apply & open draft PR** or **Dismiss**. (`no_change`/`failed` chips open the same panel to
   show the diagnosis/error.) Proposals are server-seeded onto the page, so they survive reloads
   and auto-filed tasks are visible without anyone having clicked anything.
5. **Apply** — `POST /api/fix-tasks/:id/apply` (guarded to `case.dispatch`, audited) flips the
   task to `applying` and spawns `scripts/llm-fix.mjs --apply <id>`: throwaway worktree at
   `/tmp/iam-fix-<id>` on branch `claude-fixes/<id>` cut from `origin/<default>` → re-validate
   every edit's `oldText` (drift ⇒ refuse) → apply → commit → `npx tsc --noEmit` (+ `npm test` for
   web changes) → push → `gh pr create --draft` → status **`opened_pr`** with the URL.
6. **Cleanup** — the temp worktree is always removed (and the local branch deleted if it was
   never pushed), success or failure.

## Guardrails

This is powerful automation, so the guardrails are the feature:

- **Read-only analysis** — the LLM session cannot write anything: its only tools are repo search
  and bounded file reads (`.env*`, secret/credential paths, `node_modules`, `.git` refused); its
  "output" is JSON stored on the FixTask row.
- **Human review before anything runs** — the proposal is rendered on screen (file, lines,
  before/after) and applies only when an operator clicks Apply.
- **Drift check, twice** — every edit's `oldText` must match the file exactly once at proposal
  time AND again at apply time; a stale proposal refuses rather than mis-applies.
- **Worktree isolation** — the apply step never touches your checkout or `main`; it works in a
  throwaway worktree under `/tmp`, removed in a `finally` whatever happens.
- **Checks before the PR** — tsc (and web tests when web files changed) must pass in the worktree
  or the task fails with the output in its log.
- **Draft PR only** — the worker never merges and never force-pushes. Review the diff like any
  other PR; close it if the diagnosis is wrong.
- **Failures are failures** — provider/auth/HTTP errors, timeouts and cap exhaustion all mark the
  task `failed` with the reason in the log; `no_change` is reserved for the model explicitly
  declining to propose.
- **One task per fingerprint** — `POST /api/fix-tasks` refuses (409) while a task for the same
  fingerprint is queued/running/applying (a partial unique index backstops the race), so a
  repeated failure can't fan out into parallel fixers.
- **Keys stay server-side** — provider API keys live in the `LlmProvider` table (a deliberate,
  documented platform-level exception to the "client secrets only in Delinea" rule), are masked
  to their last 4 characters in every API response, and never appear in logs or audit rows.
- **Auto mode is opt-in and rate-limited** — see below. Default off.

## Auto-trigger (opt-in)

Settings → **Self-healing fixes** → "Automatically hand repeated failures to the default LLM
provider" (the `autoFix` app setting, default **off**). When on, the heartbeat sweep
(`sweepAutoFix` in `web/lib/jobs/procurement-watch.ts`) picks up unresolved **failed** lines whose
identical fingerprint has recurred **3+ times**, and files at most **one** new FixTask per sweep
(`requestedBy: system:auto-fix`; skipped quietly when no provider is registered). A fingerprint
that ever had a FixTask is never auto-queued again — no retry loops. Auto-filed tasks stop at
**`proposed`**: an operator still reviews on /runs, and a human still merges every PR.

## Requirements

On the host that runs the web app:

- **An LLM provider** — added under Settings → LLM providers (key + model + endpoint). No CLI
  install or CLI login needed for analysis.
- **GitHub CLI** — `gh auth login` with permission to push branches and open PRs on this repo
  (used only by the Apply step).
- **Git remote** — `origin` must accept pushes of `claude-fixes/*` branches.
- The worker reads `DATABASE_URL` from `web/.env` and Prisma from `web/node_modules`, both
  resolved relative to the script's own checkout — no extra install step. The apply step shares
  the main checkout's `web/node_modules` into the worktree (symlink) for tsc/tests and strips
  `DATABASE_URL` from their environment.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| POST returns 422 "no LLM provider configured" | Add a provider under Settings → LLM providers (the first one becomes the default). |
| Task stuck `queued`, no chip movement | The spawn failed silently (rare) or the host lacks `node` on PATH for the detached child. Run it by hand: `node scripts/llm-fix.mjs --task <id>` and read stderr. |
| `failed` with a 401/403 provider error | Bad or expired API key — rotate it on the provider row (Edit → paste key) and use Test. |
| `failed: timeout` / "used all 20 tool turns" | The context may be too vague or the model too weak for the repo — try a stronger model/provider or re-trigger with a cleaner error line. |
| `no_change` | The model judged the failure environmental (credentials, vendor outage, seats) or couldn't find the root cause — its reasoning opens from the chip. That's the guardrail working: no speculative proposals. |
| `failed: drifted` on Apply | The code moved between analysis and apply (e.g. another PR merged). Re-trigger the analysis on the current code. |
| PR push fails | `gh auth status`; confirm the repo remote and that branch protection allows `claude-fixes/*`. |
| Stale worktree at `/tmp/iam-fix-*` | Only possible after a hard kill: `git worktree remove --force /tmp/iam-fix-<id>` from the main checkout. |

Fix-task rows live in the `FixTask` table; creation, apply and dismiss are audited
(`fixtask.create` / `fixtask.apply` / `fixtask.dismiss`, actor = the operator or
`system:auto-fix`); provider registry changes are audited as `settings.llmprovider.*` (never
including the key).
