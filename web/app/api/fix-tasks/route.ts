// POST /api/fix-tasks — hand a failing run-log line to the self-healing fix lane: creates a
//   FixTask and spawns the detached analyze worker (tool-calling LLM session → stores a fix
//   PROPOSAL for on-screen review; applying it later opens a draft PR — a human always merges).
//   Refuses (409) while an unfinished task exists for the same fingerprint, (422) when no LLM
//   provider is configured.
// GET  /api/fix-tasks?fingerprint=… — latest task for that fingerprint (the row status chip polls
//   this while queued/running/applying; the review panel reads proposal + log from it).
// Both guarded to case.dispatch — the same capability as running/re-running a step.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { createFixTask } from "@/lib/fixes/fix-tasks";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guard("case.dispatch");
  if (g.res) return g.res;

  let body: { fingerprint?: unknown; title?: unknown; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const context = typeof body.context === "string" ? body.context.trim() : "";
  if (!fingerprint || fingerprint.length > 128) return NextResponse.json({ error: "fingerprint is required" }, { status: 422 });
  if (!title || title.length > 300) return NextResponse.json({ error: "title must be 1–300 characters" }, { status: 422 });
  if (!context || context.length > 20000) return NextResponse.json({ error: "context must be 1–20000 characters" }, { status: 422 });

  const out = await createFixTask(db, { fingerprint, title, context, requestedBy: g.user?.email ?? "operator" });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });

  await recordAudit("fixtask.create", { user: g.user, detail: { id: out.task.id, fingerprint, title } });
  return NextResponse.json(out.task, { status: 201 });
}

export async function GET(req: Request) {
  const g = await guard("case.dispatch");
  if (g.res) return g.res;

  const fingerprint = new URL(req.url).searchParams.get("fingerprint")?.trim();
  if (!fingerprint) return NextResponse.json({ error: "fingerprint is required" }, { status: 422 });

  const task = await db.fixTask.findFirst({
    where: { fingerprint },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, prUrl: true, log: true, proposal: true, provider: true, createdAt: true, finishedAt: true, requestedBy: true, appliedBy: true },
  });
  if (!task) return NextResponse.json({ task: null });
  // The log can be long — the review panel only needs the gist.
  const logTail = task.log && task.log.length > 4000 ? task.log.slice(-4000) : task.log;
  return NextResponse.json({ task: { ...task, log: logTail } });
}
