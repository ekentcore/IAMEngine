// POST /api/feature-requests — file a feature request (any signed-in user; the 💡 header button).
// GET  /api/feature-requests — list all requests, newest first (settings.manage; the /settings triage).
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const _g = await guardAuth(); if (_g.res) return _g.res;

  let body: { title?: unknown; body?: unknown; page?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.body === "string" ? body.body.trim() : "";
  const page = typeof body.page === "string" ? body.page.trim() : "";
  if (title.length < 1 || title.length > 200) {
    return NextResponse.json({ error: "title must be 1–200 characters" }, { status: 422 });
  }
  if (description.length > 5000) {
    return NextResponse.json({ error: "description must be at most 5000 characters" }, { status: 422 });
  }
  if (page.length > 500) {
    return NextResponse.json({ error: "page must be at most 500 characters" }, { status: 422 });
  }

  const created = await db.featureRequest.create({
    data: {
      title,
      body: description,
      page,
      // Plain id/email snapshot (no FK) — the request outlives a deleted author.
      authorUserId: _g.user.system ? null : _g.user.id,
      authorEmail: _g.user.system ? null : _g.user.email,
    },
  });
  await recordAudit("feature_request.create", { user: _g.user, detail: { id: created.id, title, page } });
  return NextResponse.json(created, { status: 201 });
}

export async function GET() {
  const _g = await guard("settings.manage"); if (_g.res) return _g.res;
  const requests = await db.featureRequest.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(requests);
}
