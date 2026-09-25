// GET  /api/clients/:slug/universal-choices — the client's Universal Choices and their mapped groups.
// POST /api/clients/:slug/universal-choices — pull them from ServiceNow ("Sync choices"); mappings
// are kept (lib/clients/universal-choices-sync).
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { fetchClientChoices } from "@/lib/servicenow/universal-choices";
import { applyChoiceSync } from "@/lib/clients/universal-choices-sync";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guardAuth(); if (g.res) return g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true, serviceNowSysId: true } });
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const choices = await db.universalChoice.findMany({
    where: { clientId: client.id },
    orderBy: [{ question: "asc" }, { label: "asc" }],
    select: { id: true, question: true, label: true, value: true, m365Groups: true, googleGroups: true, syncedAt: true, goneAt: true },
  });
  return NextResponse.json({ linked: Boolean(client.serviceNowSysId), choices });
}

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true, serviceNowSysId: true } });
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!client.serviceNowSysId) return NextResponse.json({ error: "this client isn't linked to a ServiceNow account, so there are no choices to pull" }, { status: 422 });
  let pulled;
  try {
    pulled = await fetchClientChoices(snConfigFromEnv(), client.serviceNowSysId);
  } catch (e) {
    return NextResponse.json({ error: `couldn't read the Universal Choices from ServiceNow: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
  const result = await applyChoiceSync(db, client.id, pulled);
  await recordAudit("client.universal_choices.sync", { user: g.user, clientId: client.id, detail: result });
  return NextResponse.json({ ok: true, ...result });
}
