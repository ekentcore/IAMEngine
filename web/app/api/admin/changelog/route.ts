// POST /api/admin/changelog — send one change-log entry to the configured chat channels
// (Global Admin and above). The server composes the message from the entry id + the operator's
// optional comment; the client never supplies content. Bypasses the notifications master switch
// (an explicit operator action, like a test send) but uses only SAVED destinations.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { ROLE_RANK } from "@/lib/auth/permissions";
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

  await db.auditLog.create({
    data: {
      actor: g.user.email ?? "ui",
      action: "changelog.sent",
      detail: { entryId: entry.id, audience, withComment: Boolean(comment), results },
    },
  });
  return NextResponse.json({ results });
}
