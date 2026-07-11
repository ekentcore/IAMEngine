// POST /api/clients/:slug/secrets/delinea-status — the Delinea self-check for ONE client: can the
// app authenticate, read one of this client's wired secrets, and (write account + folder id
// permitting) create secrets in this client's folder? Read/write are introspected without touching
// any secret value; the write leg is tri-state ("unknown" when Secret Server won't say).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";
import {
  checkFolderRead,
  checkFolderWrite,
  checkSecret,
  delineaConfigFromEnv,
  delineaConfigured,
  getDelineaToken,
} from "@/lib/secrets/delinea";
import { delineaWriteConfigFromEnv, folderIdFor, writeAccountConfigured } from "@/lib/secrets/delinea-templates";
import { secretIsSet } from "@/lib/secrets/wiring";

export const dynamic = "force-dynamic";

type Leg = { state: "ok" | "fail" | "unknown"; detail: string };

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const client = await db.client.findUnique({
    where: { slug: params.slug },
    select: { id: true, delineaFolderId: true, secrets: { select: { externalId: true, name: true } } },
  });
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) {
    return NextResponse.json({
      token: { state: "unknown", detail: "Delinea not configured — set DELINEA_* on the app" } satisfies Leg,
      read: { state: "unknown", detail: "—" } satisfies Leg,
      write: { state: "unknown", detail: "—" } satisfies Leg,
      folderId: null,
    });
  }

  // Leg 1: the read account's token grant.
  let token: string | null = null;
  let tokenLeg: Leg;
  try {
    token = await getDelineaToken(cfg);
    tokenLeg = { state: "ok", detail: "service account authenticated" };
  } catch (e) {
    tokenLeg = { state: "fail", detail: (e as Error).message };
  }

  // Leg 2: read one of THIS client's wired secrets (metadata only — never the value).
  let readLeg: Leg = { state: "unknown", detail: "no wired secret on this client yet" };
  const wired = client.secrets.find((s) => secretIsSet(s.externalId));
  if (token && wired) {
    const r = await checkSecret(cfg, wired.externalId, undefined, token);
    readLeg = r.ok
      ? { state: "ok", detail: `read '${wired.name}' (${r.label ?? wired.externalId})` }
      : { state: "fail", detail: `'${wired.name}': ${r.error}` };
  } else if (!token) {
    readLeg = { state: "unknown", detail: "skipped — token grant failed" };
  }

  // Leg 3: could the WRITE account create secrets in this client's folder?
  const folderId = folderIdFor(params.slug, client.delineaFolderId);
  let writeLeg: Leg = { state: "unknown", detail: "no Delinea folder id for this client (set it on the client, or DELINEA_FOLDER_MAP)" };
  if (folderId) {
    const writeCfg = delineaWriteConfigFromEnv();
    if (!writeAccountConfigured(writeCfg)) {
      writeLeg = { state: "unknown", detail: "no write account configured (DELINEA_WRITE_USER/PASSWORD)" };
    } else {
      try {
        const writeToken = await getDelineaToken(writeCfg);
        const readable = await checkFolderRead(writeCfg, folderId, undefined, writeToken);
        if (!readable.ok) {
          writeLeg = { state: "fail", detail: `folder ${folderId}: ${readable.error}` };
        } else {
          const w = await checkFolderWrite(writeCfg, folderId, undefined, writeToken);
          writeLeg = { state: w.write === "ok" ? "ok" : w.write === "fail" ? "fail" : "unknown", detail: `folder '${readable.name}': ${w.detail}` };
        }
      } catch (e) {
        writeLeg = { state: "fail", detail: `write account token grant failed: ${(e as Error).message}` };
      }
    }
  }

  await recordAudit("client.delinea.selfcheck", {
    user: g.user,
    clientId: client.id,
    detail: { token: tokenLeg.state, read: readLeg.state, write: writeLeg.state, folderId },
  });
  return NextResponse.json({ token: tokenLeg, read: readLeg, write: writeLeg, folderId });
}
