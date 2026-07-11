// The self-healing fix lane's app side: create a FixTask row and hand it to the detached fixer
// worker (scripts/llm-fix.mjs at the repo root), which runs a tool-calling LLM session (provider
// from the LlmProvider registry) that stores a structured fix PROPOSAL for on-screen review; a
// second worker mode applies a reviewed proposal in an isolated worktree and opens a DRAFT PR.
// Shared by the operator route (POST /api/fix-tasks) and the opt-in auto-fix sweep. Guardrail: at
// most ONE unfinished task per fingerprint — enforced here.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getDefaultProvider } from "./providers";

// App setting key for the opt-in auto-trigger (E3). Value: { enabled: boolean }. Default OFF —
// when on, the sweep hands repeated failures to the default LLM provider automatically; the
// result is a PROPOSAL an operator still reviews (and a human still merges the eventual PR).
export const AUTO_FIX_SETTING_KEY = "autoFix";
export type AutoFixSetting = { enabled: boolean };

export const UNFINISHED_STATUSES = ["queued", "running", "applying"];
// A task the worker hasn't finished within this window is presumed dead (the worker's own hard cap
// is 10 min analyze / ~15 min apply) — reclaimed to "failed" so a rebooted/OOM-killed worker can't
// wedge the fingerprint behind the one-per-fingerprint guard forever.
const STALE_MS = 20 * 60_000;

// The structured fix proposal the analyze session stores for on-screen review.
export type FixEdit = { file: string; startLine: number; endLine: number; oldText: string; newText: string; note?: string };
export type FixProposal = { diagnosis: string; edits: FixEdit[] };

// scripts/llm-fix.mjs relative to the running web server (cwd is web/ under next; fall back to
// a repo-root cwd for safety). Returns null when the script can't be found (e.g. a stripped deploy).
export function fixerScriptPath(): string | null {
  for (const p of [path.resolve(process.cwd(), "..", "scripts", "llm-fix.mjs"), path.resolve(process.cwd(), "scripts", "llm-fix.mjs")]) {
    if (existsSync(p)) return p;
  }
  return null;
}

// Detached + unref'd: the fixer keeps running even if the web server restarts mid-fix. Its output
// goes to the FixTask row (the worker writes status/log itself), so stdio is ignored here.
export function spawnFixer(taskId: string, mode: "analyze" | "apply" = "analyze"): void {
  const script = fixerScriptPath();
  if (!script) throw new Error("scripts/llm-fix.mjs not found next to the web app");
  spawn(process.execPath, [script, mode === "apply" ? "--apply" : "--task", taskId], { detached: true, stdio: "ignore" }).unref();
}

export type CreateFixTaskInput = { fingerprint: string; title: string; context: string; requestedBy: string | null };
export type CreateFixTaskResult =
  | { ok: true; task: { id: string; status: string } }
  | { ok: false; status: 409 | 422 | 500; error: string };

// Create the row and launch the analyze worker. Refuses (409) while an unfinished task exists for
// the same fingerprint, so the same failure can't fan out into parallel fixers; refuses (422)
// when no LLM provider is configured — the worker would only fail later with less context.
export async function createFixTask(db: PrismaClient, input: CreateFixTaskInput): Promise<CreateFixTaskResult> {
  if (!(await getDefaultProvider(db))) {
    return { ok: false, status: 422, error: "no LLM provider configured — add one under Settings → LLM providers" };
  }

  // Reclaim any task that's been unfinished past the worker's lifetime — a dead worker must not
  // block this fingerprint permanently.
  await db.fixTask.updateMany({
    where: { status: { in: UNFINISHED_STATUSES }, createdAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { status: "failed", finishedAt: new Date(), log: "abandoned: the worker made no update within 20 minutes (likely crashed or was killed)" },
  });

  const existing = await db.fixTask.findFirst({
    where: { fingerprint: input.fingerprint, status: { in: UNFINISHED_STATUSES } },
    select: { id: true, status: true },
  });
  if (existing) return { ok: false, status: 409, error: `a fix task for this line is already ${existing.status}` };

  let task: { id: string; status: string };
  try {
    task = await db.fixTask.create({
      data: { fingerprint: input.fingerprint, title: input.title, context: input.context, requestedBy: input.requestedBy },
      select: { id: true, status: true },
    });
  } catch (e) {
    // Two concurrent callers (two operators, or the sweep racing a click) both passed the findFirst
    // check — the partial-unique index on (fingerprint) WHERE status in (queued,running,applying)
    // rejects the loser with P2002. Treat it as the same "already in flight" 409, not a 500.
    if ((e as { code?: string }).code === "P2002") return { ok: false, status: 409, error: "a fix task for this line is already queued" };
    throw e;
  }
  try {
    spawnFixer(task.id);
  } catch (e) {
    await db.fixTask.update({ where: { id: task.id }, data: { status: "failed", finishedAt: new Date(), log: `failed to launch the fixer: ${(e as Error).message}` } }).catch(() => {});
    return { ok: false, status: 500, error: (e as Error).message };
  }
  return { ok: true, task };
}
