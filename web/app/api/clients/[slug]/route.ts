// GET   /api/clients/:slug — client detail (systems + secrets).
// PATCH /api/clients/:slug — { action: "archive" | "restore" | "set-email-domain" }.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { normalizeDomainInput } from "@/lib/clients/email-domain";

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const repo = makeClientRepository(db);
  const client = await repo.getClientBySlug(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(client);
}

export async function PATCH(req: Request, { params }: Ctx) {
  let body: { action?: string; domain?: unknown; lock?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const repo = makeClientRepository(db);
  const existing = await repo.getClientBySlug(params.slug);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Curate (and lock) the email/UPN domain — a locked value the contact-derivation won't overwrite.
  if (body.action === "set-email-domain") {
    const raw = typeof body.domain === "string" ? body.domain.trim() : "";
    const domain = raw === "" ? null : normalizeDomainInput(raw);
    if (raw !== "" && !domain) {
      return NextResponse.json({ error: "domain must be a bare domain like acme.com" }, { status: 422 });
    }
    const lock = domain ? body.lock !== false : false; // default to locking when curating
    const client = await repo.setCuratedEmailDomain(params.slug, domain, lock);
    await repo.writeAudit({
      actor: "ui",
      action: "client.email_domain.set",
      clientId: client.id,
      detail: { emailDomain: domain, locked: lock },
    });
    return NextResponse.json(client);
  }

  if (body.action !== "archive" && body.action !== "restore") {
    return NextResponse.json({ error: 'action must be "archive", "restore", or "set-email-domain"' }, { status: 422 });
  }

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
