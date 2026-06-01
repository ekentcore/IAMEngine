// PUT /api/clients/:slug/systems — replace the client's system set (+ optional backbone).
import { NextResponse } from "next/server";
import type { Backbone } from "@prisma/client";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import type { EditableSystem } from "@/lib/clients/types";

const BACKBONES = ["entra", "google", "ad_synced", "ad_standalone"];
const LANES = ["always", "on_request", "never"];
const MODES = ["api", "browser", "manual"];

// Coerce an untrusted object into a valid EditableSystem (or null to drop it).
function sanitize(s: unknown): EditableSystem | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  const systemKey = typeof o.systemKey === "string" ? o.systemKey.trim() : "";
  if (!systemKey) return null;
  return {
    systemKey,
    mode: MODES.includes(o.mode as string) ? (o.mode as EditableSystem["mode"]) : "api",
    onboardWhen: LANES.includes(o.onboardWhen as string) ? (o.onboardWhen as EditableSystem["onboardWhen"]) : "never",
    offboardWhen: LANES.includes(o.offboardWhen as string) ? (o.offboardWhen as EditableSystem["offboardWhen"]) : "never",
    dependsOn: Array.isArray(o.dependsOn) ? o.dependsOn.map(String) : [],
    requiresApproval: Boolean(o.requiresApproval),
    captureEvidence: Boolean(o.captureEvidence),
    secretNames: Array.isArray(o.secretNames) ? o.secretNames.map(String) : [],
    config: o.config ?? null,
  };
}

export async function PUT(req: Request, { params }: { params: { slug: string } }) {
  let body: { systems?: unknown; backbone?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (!Array.isArray(body.systems)) {
    return NextResponse.json({ error: "systems[] is required" }, { status: 422 });
  }
  const systems = body.systems.map(sanitize).filter((s): s is EditableSystem => s !== null);
  // dedupe by systemKey (last wins)
  const deduped = [...new Map(systems.map((s) => [s.systemKey, s])).values()];

  let backbone: Backbone | null | undefined = undefined;
  if (body.backbone === null) backbone = null;
  else if (typeof body.backbone === "string" && BACKBONES.includes(body.backbone)) backbone = body.backbone as Backbone;

  const repo = makeClientRepository(db);
  const result = await repo.replaceSystems(params.slug, deduped, backbone);
  if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });

  await repo.writeAudit({
    actor: "ui",
    action: "client.systems.edit",
    clientId: result.clientId,
    detail: { upserted: result.upserted, removed: result.removed, backbone: backbone ?? "unchanged" },
  });
  return NextResponse.json(result);
}
