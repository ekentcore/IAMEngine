// Suggest a Delinea secret id for a secret slot, by scanning the client's own Secret Server folder.
//
// The operator adds a system (say `sentinelone`) and the app immediately answers "there's an
// 'S1_API integration' secret sitting in this client's folder — want to wire it?" instead of leaving
// them to hunt for the id by hand. Same classifier the fleet recovery sweep uses
// (lib/secrets/recovery-match.ts), so the UI and the sweep can never disagree about what a secret is.
//
// Read-only: it returns secret NAMES and IDS, never values. Only slots the caller asks about are
// scanned, and only within THIS client's folder.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { delineaConfigFromEnv, delineaConfigured, getDelineaToken } from "@/lib/secrets/delinea";
import { listFolderSecrets } from "@/lib/secrets/delinea-search";
import { candidatesBySlot } from "@/lib/secrets/recovery-match";
import { folderIdFor } from "@/lib/secrets/delinea-templates";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  const slug = params.slug;
  if (!(await clientSlugInScope(db, slug))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { secretNames?: unknown };
  const wanted = Array.isArray(body.secretNames)
    ? [...new Set(body.secretNames.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()))]
    : [];
  if (wanted.length === 0) return NextResponse.json({ suggestions: [] });

  const client = await db.client.findUnique({
    where: { slug },
    select: { id: true, delineaFolderId: true },
  });
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) {
    return NextResponse.json({ suggestions: [], note: "Delinea is not configured on the app" });
  }
  const folderId = folderIdFor(slug, client.delineaFolderId);
  if (!folderId) {
    return NextResponse.json({
      suggestions: [],
      note: "this client has no Delinea folder id — set one on the Secrets panel to enable credential suggestions",
    });
  }

  try {
    const token = await getDelineaToken(cfg);
    const records = await listFolderSecrets(cfg, Number(folderId), token);
    const bySlot = candidatesBySlot(records);

    const suggestions = wanted.flatMap((name) => {
      const cands = (bySlot.get(name) ?? []).filter((c) => !c.stale && !c.ambiguous);
      if (cands.length === 0) return [];
      const best = cands[0];
      return [{
        secretName: name,
        externalId: String(best.record.id),
        label: best.record.name,
        template: best.record.secretTemplateName ?? null,
        folderPath: best.record.folderPath,
        confidence: best.tier, // "high" = the platform's own naming/template; "medium" = a guess
        reason: best.reason,
        alternatives: cands.slice(1, 4).map((c) => ({ externalId: String(c.record.id), label: c.record.name })),
      }];
    });

    return NextResponse.json({ suggestions, scanned: records.length });
  } catch (e) {
    // A scan failure must never block adding a system — it's an assist, not a gate.
    return NextResponse.json({ suggestions: [], note: `Delinea scan failed: ${(e as Error).message}` });
  }
}
