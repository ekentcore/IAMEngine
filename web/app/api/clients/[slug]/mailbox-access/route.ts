// POST /api/clients/:slug/mailbox-access { mailboxes: [{ address, displayName?, access }] } — set the
// shared mailboxes EVERY new user for this client is granted access to by default (FR #15), with the
// access level per mailbox. Stored as config.onboard.defaultSharedMailboxes on the m365 system; the
// m365 onboard lane grants them over Exchange Online (Invoke-CtgM365ExoFinish). The executor reads
// THIS — not a runbook doc — so this is how the default access actually gets applied.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

// The Exchange access levels the runner can grant on a shared mailbox (Coretelligent.Exchange).
const ACCESS = new Set(["FullAccess", "SendAs", "SendOnBehalf"]);

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { mailboxes?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (!Array.isArray(body.mailboxes)) return NextResponse.json({ error: "mailboxes must be an array" }, { status: 422 });

  // Normalize: address is required (it's the grant identity); access defaults to FullAccess; dedupe by
  // address (last wins so re-picking a mailbox updates its level rather than duplicating it).
  const byAddress = new Map<string, { address: string; displayName?: string; access: string }>();
  for (const raw of body.mailboxes) {
    const x = raw as { address?: unknown; displayName?: unknown; access?: unknown };
    const address = typeof x.address === "string" ? x.address.trim() : "";
    if (!address) continue;
    const access = typeof x.access === "string" && ACCESS.has(x.access) ? x.access : "FullAccess";
    const displayName = typeof x.displayName === "string" && x.displayName.trim() ? x.displayName.trim() : undefined;
    byAddress.set(address.toLowerCase(), displayName ? { address, displayName, access } : { address, access });
  }
  const mailboxes = [...byAddress.values()];

  const sys = await db.clientSystem.findFirst({ where: { client: { slug: params.slug }, systemKey: "m365" }, select: { id: true, config: true, clientId: true } });
  if (!sys) return NextResponse.json({ error: "this client has no m365 system" }, { status: 404 });

  const config = { ...((sys.config ?? {}) as Record<string, unknown>) };
  config.onboard = { ...((config.onboard ?? {}) as Record<string, unknown>), defaultSharedMailboxes: mailboxes };
  await db.clientSystem.update({ where: { id: sys.id }, data: { config: config as Prisma.InputJsonValue } });
  await recordAudit("client.mailbox_access.set", { user: g.user, clientId: sys.clientId, detail: { count: mailboxes.length } });

  return NextResponse.json({ ok: true, mailboxes });
}
