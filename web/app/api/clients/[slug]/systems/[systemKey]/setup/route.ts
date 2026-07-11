// POST /api/clients/:slug/systems/:systemKey/setup — the operator-entered bits of the per-system
// setup checklist: { action: "start" | "attest" | "clear_attest", note? }. "start" records that
// setup began (instructions viewed); "attest" records that the operator verified the credential's
// RIGHTS manually — which also overrides the dispatch gate for a failing test. Everything else on
// the checklist is derived from live state, never stored.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string; systemKey: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const body = await req.json().catch(() => null) as { action?: unknown; note?: unknown } | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (!["start", "attest", "clear_attest"].includes(action)) {
    return NextResponse.json({ error: "action must be start | attest | clear_attest" }, { status: 422 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";

  const client = await db.client.findUnique({
    where: { slug: params.slug },
    select: { id: true, systems: { where: { systemKey: params.systemKey }, select: { systemKey: true } } },
  });
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (client.systems.length === 0) return NextResponse.json({ error: `client has no system '${params.systemKey}'` }, { status: 404 });

  const by = g.user.email || "ui";
  const now = new Date();
  const data =
    action === "start" ? { startedAt: now, startedBy: by }
    : action === "attest" ? { attestedAt: now, attestedBy: by, attestNote: note || null }
    : { attestedAt: null, attestedBy: null, attestNote: null };
  await db.systemSetupState.upsert({
    where: { clientId_systemKey: { clientId: client.id, systemKey: params.systemKey } },
    create: { clientId: client.id, systemKey: params.systemKey, ...data },
    update: data,
  });
  await recordAudit(`system.setup.${action}`, { user: g.user, clientId: client.id, detail: { systemKey: params.systemKey, ...(note ? { note } : {}) } });
  return NextResponse.json({ ok: true });
}
