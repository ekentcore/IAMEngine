// POST /api/clients/:slug/secrets/probe { name, values: { <fieldLabel>: value } }
// The "confirm it's working" step of the guided setup: test a credential's RAW field values BEFORE any
// vault write. Writes NOTHING — no Delinea create, no reference stored. Returns only a verdict:
//   { probeable, blocking, ok, error?, hint?, label?, kind? }
// m365-admin runs the real Entra client-credentials grant (blocking); ad-dc checks whether the client's
// own AD-capable runner is reachable (advisory). Values are used once to produce the verdict and are
// never persisted or logged — this route stores and audits nothing.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { probeSecretValues } from "@/lib/secrets/value-probe";
import { secretRunnerReach } from "@/lib/runner/reachability";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets");
  if (g.res) return g.res;

  let body: { name?: unknown; values?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 422 });
  const values: Record<string, string> = {};
  if (body.values && typeof body.values === "object") {
    for (const [k, v] of Object.entries(body.values as Record<string, unknown>)) {
      if (typeof v === "string") values[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") values[k] = String(v);
    }
  }

  // Scope-gate: an out-of-scope (restricted) client reads as not-found, like the setup page.
  const scope = await currentClientScope(db);
  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true, primaryDomain: true } });
  if (!client || !scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const probe = await probeSecretValues(name, values, {
    clientPrimaryDomain: client.primaryDomain ?? undefined,
    agentReach: () => secretRunnerReach(db, client.id, name),
  });

  return NextResponse.json(probe);
}
