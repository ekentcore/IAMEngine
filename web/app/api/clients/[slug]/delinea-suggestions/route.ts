// GET /api/clients/:slug/delinea-suggestions?secret=<name> — ranked existing-secret suggestions from
// the client's own Delinea folder tree (names/notes/metadata only, never values). Gated read.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { delineaConfigFromEnv, delineaConfigured, getDelineaToken, deriveClientFolderId } from "@/lib/secrets/delinea";
import { listFolderSecrets } from "@/lib/secrets/delinea-search";
import { buildSuggestions } from "@/lib/secrets/build-suggestions";
import { identitySubfolderName } from "@/lib/secrets/delinea-templates";
import { apiSetupBySecretName } from "@/lib/secrets/api-setup-catalog";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const secret = new URL(req.url).searchParams.get("secret")?.trim();
  if (!secret) return NextResponse.json({ error: "secret query param required" }, { status: 422 });

  const scope = await currentClientScope(db);
  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true, name: true, delineaFolderId: true } });
  if (!client || !scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) return NextResponse.json({ folderResolved: false, suggestions: [], reason: "Delinea not configured" });

  let token: string;
  try { token = await getDelineaToken(cfg); }
  catch (e) { return NextResponse.json({ folderResolved: false, suggestions: [], reason: `Delinea auth failed — ${(e as Error).message}` }, { status: 502 }); }

  // Client folder: stored id, else best-effort derivation from the client's slug/name.
  let folderId: string | null = client.delineaFolderId ?? null;
  if (!folderId) {
    const d = await deriveClientFolderId(cfg, { slug: params.slug, name: client.name }, token).catch(() => null);
    folderId = d?.folderId ?? null;
  }

  const result = await buildSuggestions(
    {
      listSecrets: (fid) => listFolderSecrets(cfg, fid, token),
      fetchNote: async (id) => {
        // /summary is metadata-only (no secret value). The note field name varies by Secret Server
        // version — tolerate both `notes` and `secretNote`.
        const res = await fetch(`${cfg.baseUrl}/api/v1/secrets/${id}/summary`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return undefined;
        const b = (await res.json().catch(() => null)) as { notes?: string; secretNote?: string } | null;
        const n = (b?.notes ?? b?.secretNote ?? "").trim();
        return n || undefined;
      },
    },
    // Rank the secret's OWN target subfolder first (a vendor cred prefers "Vendor"; an identity cred
    // prefers "Identity Services"), then the identity default, deduped.
    { clientFolderId: folderId, secretName: secret, subfolders: [...new Set([apiSetupBySecretName(secret)?.delineaSubfolder ?? identitySubfolderName(), identitySubfolderName(), "Vendor"])], noteTopN: 5 }
  );
  return NextResponse.json(result);
}
