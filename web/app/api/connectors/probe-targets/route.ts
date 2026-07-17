// GET /api/connectors/probe-targets — the client/secret picker behind the HAR import's credential
// probe (connector.manage). Lists every live client that has at least one WIRED secret, with the
// wired secret names. A brand-new connector's logical secret name is wired nowhere yet, so the
// picker offers what actually exists — any client's existing secret can be lent to a probe.
// Names and slugs only: never an externalId, never a value.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { secretIsSet } from "@/lib/secrets/wiring";

export const dynamic = "force-dynamic";

export async function GET() {
  const _g = await guard("connector.manage"); if (_g.res) return _g.res;

  const secrets = await db.secret.findMany({
    where: { client: { archivedAt: null } },
    select: { name: true, externalId: true, client: { select: { slug: true, name: true } } },
    orderBy: [{ client: { name: "asc" } }, { name: "asc" }],
  });

  const byClient = new Map<string, { slug: string; name: string; secrets: string[] }>();
  for (const s of secrets) {
    if (!secretIsSet(s.externalId)) continue;
    const cur = byClient.get(s.client.slug) ?? { slug: s.client.slug, name: s.client.name, secrets: [] };
    cur.secrets.push(s.name);
    byClient.set(s.client.slug, cur);
  }
  return NextResponse.json({ clients: [...byClient.values()] });
}
