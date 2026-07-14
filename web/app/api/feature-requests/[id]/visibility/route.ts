// POST /api/feature-requests/:id/visibility — { action: "hide" | "unhide" } (feature_request.hide,
// i.e. global_admin + super_admin only).
//
//   hide    drop it into the Completed table now, without waiting out the 7-day timer
//   unhide  put it back on the board for another 7 days — repeatable, 7 days at a time
//
// BOTH actions are refused on an open request. Guarding only `hide` would leave `unhide` able to arm
// a 7-day timer on a request nobody has implemented, which would then silently retire itself into a
// table called "Completed" a week later — the precise outcome the guard exists to prevent.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { frHideWindowFrom, frIsHideable } from "@/lib/feature-requests/visibility";
import { toFeatureRequestRow } from "@/lib/feature-requests/serialize";

type Ctx = { params: { id: string } };

export async function POST(req: Request, { params }: Ctx) {
  const _g = await guard("feature_request.hide"); if (_g.res) return _g.res;

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (body.action !== "hide" && body.action !== "unhide") {
    return NextResponse.json({ error: 'action must be "hide" or "unhide"' }, { status: 422 });
  }
  const action = body.action;

  const existing = await db.featureRequest.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const now = new Date();
  if (!frIsHideable(existing.status)) {
    return NextResponse.json(
      { error: "only an implemented or rejected request has a hide timer — set its status first" },
      { status: 422 },
    );
  }

  const hideAt = action === "hide" ? now : frHideWindowFrom(now);
  const updated = await db.featureRequest.update({ where: { id: params.id }, data: { hideAt } });
  await recordAudit(action === "hide" ? "feature_request.hide" : "feature_request.unhide", {
    user: _g.user,
    detail: { id: updated.id, number: updated.number, title: updated.title, hideAt: hideAt.toISOString() },
  });
  return NextResponse.json(toFeatureRequestRow(updated, now));
}
