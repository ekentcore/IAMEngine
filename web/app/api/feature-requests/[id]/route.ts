// PATCH /api/feature-requests/:id — triage a request: { status?, resolutionNote? } (settings.manage).
// Flipping a request to "done" (Implemented) arms its 7-day hide timer here; flipping it back to any
// open status disarms it. See lib/feature-requests/visibility.ts for why the timer is a timestamp
// rather than a swept flag.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { FR_STATUSES } from "@/lib/feature-requests/status";
import { frHideAtOnStatusChange } from "@/lib/feature-requests/visibility";
import { toFeatureRequestRow } from "@/lib/feature-requests/serialize";

type Ctx = { params: { id: string } };

export async function PATCH(req: Request, { params }: Ctx) {
  const _g = await guard("settings.manage"); if (_g.res) return _g.res;

  let body: { status?: unknown; resolutionNote?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const data: { status?: string; resolutionNote?: string | null; hideAt?: Date | null } = {};
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !(FR_STATUSES as readonly string[]).includes(body.status)) {
      return NextResponse.json({ error: `status must be one of ${FR_STATUSES.join(", ")}` }, { status: 422 });
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

  // Only a real transition touches the timer — undefined leaves an admin's manual hide intact.
  if (data.status !== undefined) {
    const hideAt = frHideAtOnStatusChange(existing.status, data.status, new Date());
    if (hideAt !== undefined) data.hideAt = hideAt;
  }

  const updated = await db.featureRequest.update({ where: { id: params.id }, data });
  await recordAudit("feature_request.update", {
    user: _g.user,
    detail: {
      id: updated.id,
      number: updated.number,
      title: updated.title,
      from: existing.status,
      to: updated.status,
      notedResolution: data.resolutionNote !== undefined,
      hideAt: updated.hideAt?.toISOString() ?? null,
    },
  });
  return NextResponse.json(toFeatureRequestRow(updated));
}
