// GET  /api/cases/:id/exchange-convert-default -> { offer: boolean, slug, clientName }
// POST /api/cases/:id/exchange-convert-default    make convert-to-shared this CLIENT's default
//
// The follow-up to a one-off `convert` answer (see ./mailbox-decision). Answering a decision resolves
// ONE case and deliberately does not rewrite client config — an operator clearing a case should never
// silently change how every future offboard for that client behaves. But when the reason the case
// needed answering is that the client has no conversion configured at all, leaving it there means the
// next offboard parks on the identical warning. So: offer it, explicitly, as its own click.
//
// Stateless by construction — there is no "dismissed" flag to store or migrate. The offer exists
// exactly while (this case used a one-off override) AND (the client still has no default). Applying it
// makes the second half false, and the offer disappears on its own.
//
// It lives under /cases/:id because that is the context the operator is in (the run report knows the
// case, not the slug), but it MUTATES A CLIENT — so it is gated on client.edit_systems, NOT the
// case.dispatch that answering the decision needs. That difference is intentional: an engineer can
// resolve their case; changing the fleet's behaviour for a client is an ops_manager decision.
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

// The exchange step of THIS case carries a one-off convertToShared (the operator pressed Convert), and
// the client's own exchange system still has none. Both halves matter: without the first this is just
// a client that never converts and nobody has asked to change that; without the second there is
// nothing to apply.
async function readState(caseId: string) {
  const c = await db.caseRequest.findUnique({
    where: { id: caseId },
    select: {
      clientId: true,
      client: { select: { slug: true, name: true } },
      jobs: { where: { systemKey: "exchange" }, select: { request: true } },
    },
  });
  if (!c) return null;
  const usedOverride = c.jobs.some(
    (j) => ((((j.request ?? {}) as Record<string, unknown>).config ?? {}) as { convertToShared?: unknown }).convertToShared === true,
  );
  const sys = await db.clientSystem.findFirst({ where: { clientId: c.clientId, systemKey: "exchange" }, select: { id: true, config: true } });
  const cfg = (sys?.config ?? {}) as { offboard?: Record<string, unknown> | null };
  const offboard = (cfg.offboard ?? null) as Record<string, unknown> | null;
  // Mirrors the runner's read order (Coretelligent.Exchange.psm1: `convertToShared`, else the nested
  // `mailbox.convertToShared`) so we never offer to add a default the client already has in the other
  // shape. `null` is a real configured value meaning "no" and counts as configured.
  const nested = (offboard?.mailbox ?? null) as { convertToShared?: unknown } | null;
  const configured = offboard != null && (offboard.convertToShared !== undefined || nested?.convertToShared !== undefined);
  return { client: c.client, clientId: c.clientId, sys, cfg, offboard, usedOverride, configured };
}

export async function GET(_req: Request, { params }: Ctx) {
  const g = await guardAuth(); if (g.res) return g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const s = await readState(params.id);
  if (!s) return NextResponse.json({ error: "case not found" }, { status: 404 });
  return NextResponse.json({ offer: s.usedOverride && !s.configured && !!s.sys, clientName: s.client?.name ?? null, slug: s.client?.slug ?? null });
}

export async function POST(_req: Request, { params }: Ctx) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const s = await readState(params.id);
  if (!s) return NextResponse.json({ error: "case not found" }, { status: 404 });
  if (!s.sys) return NextResponse.json({ error: "this client has no Exchange system to configure" }, { status: 422 });
  if (s.configured) return NextResponse.json({ error: "this client already has a convert-to-shared setting" }, { status: 409 });

  // Merge, never replace: the offboard bag carries the rest of the client's Exchange offboard config
  // (CAS blocks, auto-reply, DL removal). This adds one key to it — a `null` offboard becomes a bag
  // holding only this key, which is exactly the Easterseals shape.
  const config = { ...s.cfg, offboard: { ...(s.offboard ?? {}), convertToShared: true } };
  await db.clientSystem.update({ where: { id: s.sys.id }, data: { config: config as Prisma.InputJsonValue } });
  await recordAudit("client.system.config.update", {
    user: g.user,
    caseRequestId: params.id,
    clientId: s.clientId,
    detail: { systemKey: "exchange", changed: ["offboard.convertToShared=true"], via: "mailbox decision follow-up" },
  });
  return NextResponse.json({ ok: true });
}
