// GET /api/clients/:slug/sn-contacts — the customer_contact people for this client's account, to
// populate the intake-rule contact picker (FR #0000019). Requires an authorized, in-scope operator.
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { fetchAccountContacts, fetchSnAccountByCoreId, snConfigFromEnv } from "@/lib/servicenow/gateway";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const c = await db.client.findUnique({ where: { slug: params.slug }, select: { serviceNowSysId: true, coreId: true } });
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  let accountSysId = c.serviceNowSysId ?? "";
  // Fallback: resolve the account by CORE id if the sys_id isn't cached (fetchSnAccountByCoreId
  // returns display-value fields, so sys_id comes back as { value, display_value }).
  if (!accountSysId && c.coreId) {
    try {
      const account = await fetchSnAccountByCoreId(snConfigFromEnv(), c.coreId);
      accountSysId = account?.sys_id?.value ?? "";
    } catch {
      accountSysId = "";
    }
  }
  if (!accountSysId) return NextResponse.json({ error: "client has no ServiceNow account sys_id" }, { status: 409 });

  try {
    const contacts = await fetchAccountContacts(snConfigFromEnv(), accountSysId);
    return NextResponse.json({ contacts });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "ServiceNow lookup failed" }, { status: 502 });
  }
}
