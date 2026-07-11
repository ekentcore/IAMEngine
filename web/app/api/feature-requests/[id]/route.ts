// PATCH /api/feature-requests/:id — triage a request: { status?, resolutionNote? } (settings.manage).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";

const STATUSES = ["new", "planned", "building", "done", "declined"];

type Ctx = { params: { id: string } };

export async function PATCH(req: Request, { params }: Ctx) {
  const _g = await guard("settings.manage"); if (_g.res) return _g.res;

  let body: { status?: unknown; resolutionNote?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const data: { status?: string; resolutionNote?: string | null } = {};
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUSES.includes(body.status)) {
      return NextResponse.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 422 });
    }
    data.status = body.status;
  }
  if (body.resolutionNote !== undefined) {
    if (body.resolutionNote !== null && typeof body.resolutionNote !== "string") {
      return NextResponse.json({ error: "resolutionNote must be a string or null" }, { status: 422 });
    }
    const note = typeof body.resolutionNote === "string" ? body.resolutionNote.trim() : "";
    if (note.length > 5000) return NextResponse.json({ error: "resolutionNote must be at most 5000 characters" }, { status: 422 });
    data.resolutionNote = note === "" ? null : note;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update — send status and/or resolutionNote" }, { status: 422 });
  }

  const existing = await db.featureRequest.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const updated = await db.featureRequest.update({ where: { id: params.id }, data });
  await recordAudit("feature_request.update", {
    user: _g.user,
    detail: { id: updated.id, title: updated.title, from: existing.status, to: updated.status, notedResolution: data.resolutionNote !== undefined },
  });
  return NextResponse.json(updated);
}
