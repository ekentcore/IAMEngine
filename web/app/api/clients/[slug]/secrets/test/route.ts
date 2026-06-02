// POST /api/clients/:slug/secrets/test — preflight: resolve each Delinea reference far enough to
// prove the app can read it, WITHOUT pulling the value. Tests the ids in the request body (the
// engineer's current edits) so "Test" reflects what's on screen, saved or not. Returns pass/fail
// per secret; the value never leaves Delinea.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { checkSecret, delineaConfigFromEnv } from "@/lib/secrets/delinea";

export const dynamic = "force-dynamic";

type TestItem = { name: string; externalId: string };

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  let body: { secrets?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (!Array.isArray(body.secrets)) {
    return NextResponse.json({ error: "secrets[] is required" }, { status: 422 });
  }

  const repo = makeClientRepository(db);
  const wiring = await repo.secretsWiring(params.slug);
  if (!wiring) return NextResponse.json({ error: "not found" }, { status: 404 });

  const items: TestItem[] = body.secrets
    .map((s): TestItem | null => {
      if (!s || typeof s !== "object") return null;
      const o = s as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      if (!name) return null;
      return { name, externalId: typeof o.externalId === "string" ? o.externalId.trim() : "" };
    })
    .filter((i): i is TestItem => i !== null);

  const cfg = delineaConfigFromEnv();
  const results = await Promise.all(
    items.map(async (i) => {
      const r = await checkSecret(cfg, i.externalId);
      return { name: i.name, ok: r.ok, label: r.label, error: r.error };
    })
  );

  await repo.writeAudit({
    actor: "ui",
    action: "client.secrets.test",
    clientId: wiring.clientId,
    detail: { tested: results.length, passed: results.filter((r) => r.ok).length },
  });
  return NextResponse.json({ results });
}
