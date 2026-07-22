// POST /api/admin/feature-requests/:id/announce — send one feature request to the configured chat
// channels (Global Admin and above). Mirrors POST /api/admin/changelog: the server composes the
// message from the request itself (number, title, body, resolution note) plus the operator's optional
// comment — the client only picks the audience. Bypasses the notifications master switch (an explicit
// operator action, like a test send) but uses only SAVED destinations.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { ROLE_RANK } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting } from "@/lib/settings";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings } from "@/lib/notifications/types";
import { sendAnnouncement, type AnnouncementAudience } from "@/lib/notifications/sender";
import { frAnnouncement } from "@/lib/feature-requests/announce";

const AUDIENCES: AnnouncementAudience[] = ["all", "restricted", "both"];
const COMMENT_MAX = 2000;

type Ctx = { params: { id: string } };

export async function POST(req: Request, { params }: Ctx) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  // Sends post to REAL customer chat channels, so unlike read-only admin surfaces this endpoint
  // refuses the auth-off synthetic system admin — a real signed-in operator is required.
  if (g.user.system) {
    return NextResponse.json({ error: "sign in required to send to chat" }, { status: 403 });
  }
  if (ROLE_RANK[g.user.role] < ROLE_RANK.global_admin) {
    return NextResponse.json({ error: "global admin or above required" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { audience?: unknown; comment?: unknown } | null;
  const audience = AUDIENCES.includes(body?.audience as AnnouncementAudience) ? (body!.audience as AnnouncementAudience) : null;
  if (!audience) return NextResponse.json({ error: "audience must be all, restricted, or both" }, { status: 400 });
  const comment = typeof body?.comment === "string" ? body.comment.trim().slice(0, COMMENT_MAX) : "";

  const fr = await db.featureRequest.findUnique({ where: { id: params.id } });
  if (!fr) return NextResponse.json({ error: "unknown feature request" }, { status: 404 });

  const { title, detail } = frAnnouncement(fr, comment);
  const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));
  const results = await sendAnnouncement(settings, audience, { event: "announcement", title, detail });

  // recordAudit swallows its own errors — the message already went out, so an audit blip must not
  // 500 this response (the operator would re-send and double-post to the client chats).
  await recordAudit("feature_request.sent", {
    user: g.user,
    detail: { id: fr.id, number: fr.number, title: fr.title, audience, withComment: Boolean(comment), results },
  });
  return NextResponse.json({ results });
}
