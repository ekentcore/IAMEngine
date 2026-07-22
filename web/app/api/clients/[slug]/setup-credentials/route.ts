// GET /api/clients/:slug/setup-credentials — the provenance of module credential setups for this client:
// which Delinea secret (and folder) was used to set up each module, and who/when. Read-only; used by the
// guided setup UI to show "last set up with Delinea secret <id> on <date>" so an operator changing a
// vendor's permissions knows exactly which credential to edit. Scope-gated like the rest of the client API.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { clientSlugInScope } from "@/lib/auth/client-scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true } });
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rows = await db.moduleSetupCredential.findMany({
    where: { clientId: client.id },
    select: { moduleKey: true, delineaSecretId: true, delineaFolderId: true, setAt: true },
    orderBy: { moduleKey: "asc" },
  });
  // Keyed by moduleKey for a trivial client-side lookup. Never returns the credential VALUE — only the
  // Delinea reference id, the folder, and when it was set (all non-secret).
  const byModule: Record<string, { delineaSecretId: string; delineaFolderId: string | null; setAt: string }> = {};
  for (const r of rows) byModule[r.moduleKey] = { delineaSecretId: r.delineaSecretId, delineaFolderId: r.delineaFolderId, setAt: r.setAt.toISOString() };
  return NextResponse.json({ setupCredentials: byModule });
}
