// POST /api/admin/changelog — send one change-log entry to the configured chat channels
// (Global Admin and above). The server composes the message from the entry id + the operator's
// optional comment; the client never supplies content. Bypasses the notifications master switch
// (an explicit operator action, like a test send) but uses only SAVED destinations.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { ROLE_RANK } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting } from "@/lib/settings";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings } from "@/lib/notifications/types";
import { sendAnnouncement, type AnnouncementAudience } from "@/lib/notifications/sender";
import { CHANGELOG } from "@/lib/changelog/entries";

const AUDIENCES: AnnouncementAudience[] = ["all", "restricted", "both"];
const COMMENT_MAX = 2000;

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  // Sends post to REAL customer chat channels, so unlike read-only admin surfaces this endpoint
  // refuses the auth-off synthetic system admin — a real signed-in operator is required.
  if (g.user.system) {
    return NextResponse.json({ error: "sign in required to send announcements" }, { status: 403 });
  }
  if (ROLE_RANK[g.user.role] < ROLE_RANK.global_admin) {
    return NextResponse.json({ error: "global admin or above required" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { entryId?: unknown; audience?: unknown; comment?: unknown } | null;
  const entry = CHANGELOG.find((e) => e.id === body?.entryId);
  if (!entry) return NextResponse.json({ error: "unknown change-log entry" }, { status: 400 });
  const audience = AUDIENCES.includes(body?.audience as AnnouncementAudience) ? (body!.audience as AnnouncementAudience) : null;
  if (!audience) return NextResponse.json({ error: "audience must be all, restricted, or both" }, { status: 400 });
  const comment = typeof body?.comment === "string" ? body.comment.trim().slice(0, COMMENT_MAX) : "";

  const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));
  const detail = [
    ...(comment ? [comment, ""] : []),
    `Shipped: ${entry.date}${entry.approx ? " (approx.)" : ""}`,
    ...entry.items.map((it) => `• ${it}`),
  ].join("\n");
  const results = await sendAnnouncement(settings, audience, {
    event: "announcement",
    title: `iam-engine update — ${entry.title}`,
    detail,
  });

  // recordAudit swallows its own errors — the announcement already went out, so an audit blip must
  // not 500 this response (the operator would re-send and double-post to the client chats).
  await recordAudit("changelog.sent", { user: g.user, detail: { entryId: entry.id, audience, withComment: Boolean(comment), results } });
  return NextResponse.json({ results });
}
