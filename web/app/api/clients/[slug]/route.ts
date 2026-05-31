// GET   /api/clients/:slug — client detail (systems + secrets).
// PATCH /api/clients/:slug — { action: "archive" | "restore" } ("offboard a client").
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const repo = makeClientRepository(db);
  const client = await repo.getClientBySlug(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(client);
}

export async function PATCH(req: Request, { params }: Ctx) {
  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (body.action !== "archive" && body.action !== "restore") {
    return NextResponse.json({ error: 'action must be "archive" or "restore"' }, { status: 422 });
  }

  const repo = makeClientRepository(db);
  const existing = await repo.getClientBySlug(params.slug);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const status = body.action === "archive" ? "archived" : "active";
  const client = await repo.setStatus(params.slug, status);
  await repo.writeAudit({
    actor: "ui",
    action: body.action === "archive" ? "client.archive" : "client.restore",
    clientId: client.id,
    detail: { name: client.name },
  });
  return NextResponse.json(client);
}
