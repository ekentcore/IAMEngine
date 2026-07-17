// In-app PR list + merge, backed by the host checkout's own tooling: `gh` for the list and
// scripts/prs.sh for the merge — so a merge from Settings behaves exactly like one from the
// terminal (branch caught up to main first, squash, branch delete, local main sync + npm install,
// finished-worktree retirement). Server-only.
//
// Availability is a host property, not a config: the repo root above web/ must carry
// scripts/prs.sh and `gh` must be on PATH + authenticated-enough to list. On Azure there is no
// checkout and no gh, so the whole feature reports unavailable and the UI renders nothing.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// process.cwd() is web/ under `next dev`/`next start`; the repo root is its parent.
export function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

export function prsScriptPath(): string {
  return path.join(repoRoot(), "scripts", "prs.sh");
}

let ghChecked: boolean | null = null;
function hasGh(): Promise<boolean> {
  if (ghChecked !== null) return Promise.resolve(ghChecked);
  return new Promise((resolve) => {
    execFile("gh", ["--version"], { timeout: 10_000 }, (err) => {
      ghChecked = !err;
      resolve(ghChecked);
    });
  });
}

export async function prsAvailable(): Promise<boolean> {
  return existsSync(prsScriptPath()) && (await hasGh());
}

export type PrRow = {
  number: number;
  title: string;
  isDraft: boolean;
  mergeStateStatus: string; // CLEAN | BLOCKED | DIRTY (conflicting) | UNSTABLE | UNKNOWN …
  ci: "pass" | "fail" | "pending" | "none";
};

type GhPr = {
  number: number;
  title: string;
  isDraft: boolean;
  mergeStateStatus?: string;
  statusCheckRollup?: { conclusion?: string | null; status?: string | null }[] | null;
};

// Collapse gh's per-check rollup into one chip. Pure + exported for tests.
export function ciSummary(rollup: GhPr["statusCheckRollup"]): PrRow["ci"] {
  if (!rollup || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup) {
    const concl = (c.conclusion ?? "").toUpperCase();
    if (concl === "FAILURE" || concl === "TIMED_OUT" || concl === "CANCELLED" || concl === "ACTION_REQUIRED") return "fail";
    if (!concl || (c.status ?? "").toUpperCase() !== "COMPLETED") pending = true;
  }
  return pending ? "pending" : "pass";
}

export function listOpenPrs(): Promise<PrRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["pr", "list", "--json", "number,title,isDraft,mergeStateStatus,statusCheckRollup", "--limit", "50"],
      { cwd: repoRoot(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim() || err.message));
        try {
          const prs = (JSON.parse(stdout) as GhPr[]).map((p) => ({
            number: p.number,
            title: p.title,
            isDraft: p.isDraft,
            mergeStateStatus: p.mergeStateStatus ?? "UNKNOWN",
            ci: ciSummary(p.statusCheckRollup),
          }));
          resolve(prs);
        } catch {
          reject(new Error("could not parse gh pr list output"));
        }
      }
    );
  });
}

// Run scripts/prs.sh <number> --yes and hand back everything it printed. The script is the source
// of truth for merge behaviour; with no terminal attached it resolves mechanical conflicts and
// rolls back real ones, so this can't half-merge. Output is truncated defensively — it's shown in
// a dialog, not archived.
const MERGE_TIMEOUT_MS = 10 * 60_000;
export function mergePr(number: number): Promise<{ ok: boolean; exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [prsScriptPath(), String(number), "--yes"],
      { cwd: repoRoot(), timeout: MERGE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n").slice(-20_000);
        const exitCode = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : 1) : 0;
        resolve({ ok: !err, exitCode, output: output || (err ? err.message : "") });
      }
    );
  });
}
