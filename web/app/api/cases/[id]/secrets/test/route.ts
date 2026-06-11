// POST /api/cases/:id/secrets/test — preflight the case's effective Delinea references (or the
// on-screen edits passed in the body), proving the app can resolve each WITHOUT pulling the value.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { caseSecretStatus } from "@/lib/cases/case-secrets-repo";
import { checkSecret, delineaConfigFromEnv, delineaConfigured, getDelineaToken } from "@/lib/secrets/delinea";

export const dynamic = "force-dynamic";

type TestItem = { name: string; externalId: string };

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.view"); if (_g.res) return _g.res;
  let body: { secrets?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body = test the saved effective refs */ }

  const status = await caseSecretStatus(db, params.id);
  if (status === null) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Only ever test secrets the case actually uses (bounds the work + ignores junk names), whether
  // testing the on-screen edits or the saved effective references.
  const allowed = new Map(status.map((s) => [s.name, s.externalId ?? ""]));
  let items: TestItem[];
  if (Array.isArray(body.secrets)) {
    items = body.secrets
      .map((s): TestItem | null => {
        if (!s || typeof s !== "object") return null;
        const o = s as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name.trim() : "";
        return name && allowed.has(name) ? { name, externalId: typeof o.externalId === "string" ? o.externalId.trim() : "" } : null;
      })
      .filter((i): i is TestItem => i !== null);
  } else {
    items = [...allowed.entries()].map(([name, externalId]) => ({ name, externalId }));
  }

  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) {
    return NextResponse.json({ results: items.map((i) => ({ name: i.name, ok: false, error: "Delinea not configured on the app" })) });
  }

  let token: string;
  try { token = await getDelineaToken(cfg); }
  catch (e) { return NextResponse.json({ results: items.map((i) => ({ name: i.name, ok: false, error: (e as Error).message })) }); }

  const results = await Promise.all(
    items.map(async (i) => {
      if (!i.externalId || i.externalId === "REPLACE_ME") return { name: i.name, ok: false, error: "not set" };
      const r = await checkSecret(cfg, i.externalId, undefined, token);
      return { name: i.name, ok: r.ok, label: r.label, error: r.error };
    })
  );
  return NextResponse.json({ results });
}
