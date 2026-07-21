// Mimecast console sign-in test (Phase 1 of the browser auto-setup). The guided-setup modal's
// "Automatic (browser)" tab drives this:
//   POST  → dispatch a sign-in-only browser job (refusing with an actionable message when the
//           mimecast-console login isn't wired), returns { jobId }.
//   GET ?jobId= → report { done, ok, error } off the job's terminal status, so the modal can poll.
// The job only signs into login.mimecast.com and reports success — it changes nothing.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { secretIsSet } from "@/lib/secrets/wiring";
import { dispatchMimecastConsoleJob, MIMECAST_CONSOLE_SECRET_NAME } from "@/lib/secrets/dispatch-mimecast-console-job";
import { MIMECAST_CONSOLE_SETUP_KEY } from "@/lib/jobs/adhoc";

export const dynamic = "force-dynamic";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "skipped", "manual"]);

// Flatten every string leaf of the runner's opaque result JSON, so a screenshot path / message
// recorded anywhere in the shape is surfaced. Depth-bounded.
function flattenStrings(v: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap((x) => flattenStrings(x, depth + 1));
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap((x) => flattenStrings(x, depth + 1));
  return [];
}

async function resolveClient(slug: string) {
  const scope = await currentClientScope(db);
  const client = await db.client.findUnique({ where: { slug }, select: { id: true } });
  if (!client || !scopeAllows(scope, client.id)) return null;
  return client;
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const client = await resolveClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });

  // An optional per-run Delinea secret ID typed into the modal: the runner signs in with it transiently
  // via a case-level secretOverride — nothing is stored on the client. Body may be empty (no ref).
  const body = await req.json().catch(() => ({}));
  const consoleSecretRef = typeof body?.consoleSecretRef === "string" ? body.consoleSecretRef.trim() : "";

  // With no per-run ref, the console login must already be wired (persistent client secret) — otherwise
  // the job would be unclaimable (every listed secret is required at claim time). Refuse up front with
  // the fix. A supplied ref satisfies the claim gate on its own, so skip the check.
  if (!consoleSecretRef) {
    const consoleSecret = await db.secret.findUnique({
      where: { clientId_name: { clientId: client.id, name: MIMECAST_CONSOLE_SECRET_NAME } },
      select: { externalId: true },
    });
    if (!secretIsSet(consoleSecret?.externalId)) {
      return NextResponse.json(
        {
          error:
            "No Mimecast console login is wired. Either enter a Delinea secret ID above, or create a mimecast-console secret in Delinea (the Mimecast admin email + password), enable One-Time Password on it for MFA, wire it on this client, then test. See /help/mimecast.",
          needsConsoleSecret: true,
        },
        { status: 409 },
      );
    }
  }

  const res = await dispatchMimecastConsoleJob({ db, client, signInOnly: true, consoleSecretRef: consoleSecretRef || undefined });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  await recordAudit("mimecast.console.signin_test.dispatch", { user: g.user, clientId: client.id, jobId: res.jobId, detail: { usedSecretRef: Boolean(consoleSecretRef) } });
  return NextResponse.json({ ok: true, jobId: res.jobId });
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const client = await resolveClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });

  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 422 });

  // Scope the job to THIS client's console-test work — a jobId from another client/case must not leak.
  const job = await db.job.findFirst({
    where: { id: jobId, systemKey: MIMECAST_CONSOLE_SETUP_KEY, case: { clientId: client.id } },
    select: { status: true, error: true, result: true },
  });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  const done = TERMINAL_STATUSES.has(job.status);
  if (!done) return NextResponse.json({ done: false, status: job.status });

  const ok = job.status === "succeeded";
  // On failure, prefer the job.error (the runner records the flow's error + screenshot path there);
  // fall back to any string leaf of the result. Never echoes credential values (the flow never puts
  // any on these fields).
  const error = ok ? undefined : job.error || flattenStrings(job.result).find((s) => /error|could not|failed|screenshot/i.test(s)) || "sign-in failed";
  return NextResponse.json({ done: true, ok, error });
}
