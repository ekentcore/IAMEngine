// GET   /api/clients/:slug — client detail (systems + secrets).
// PATCH /api/clients/:slug — { action: "archive" | "restore" | "set-email-domain" }.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import type { Backbone } from "@prisma/client";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { normalizeDomainInput } from "@/lib/clients/email-domain";
import { hardRefreshClient } from "@/lib/clients/hard-refresh";
import { SnGatewayError } from "@/lib/servicenow/gateway";

const BACKBONES = ["entra", "google", "ad_synced", "ad_standalone"];

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const repo = makeClientRepository(db);
  const client = await repo.getClientBySlug(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(client);
}

export async function PATCH(req: Request, { params }: Ctx) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  let body: { action?: string; domain?: unknown; lock?: unknown; backbone?: unknown; pattern?: unknown; intakeSource?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const repo = makeClientRepository(db);
  const existing = await repo.getClientBySlug(params.slug);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Inline table edit: the website domain.
  if (body.action === "set-domain") {
    const domain = normalizeDomainInput(typeof body.domain === "string" ? body.domain : "");
    if (!domain) return NextResponse.json({ error: "domain must be a domain like acme.com" }, { status: 422 });
    const client = await repo.setPrimaryDomain(params.slug, domain);
    await repo.writeAudit({ actor: "ui", action: "client.domain.set", clientId: client.id, detail: { primaryDomain: domain } });
    return NextResponse.json(client);
  }

  // Inline table edit: the email/UPN name format (identity.usernamePatterns[0]).
  if (body.action === "set-username-pattern") {
    const raw = typeof body.pattern === "string" ? body.pattern.trim() : "";
    const local = raw.split("@")[0]; // accept a full pattern or just the local part
    if (!/\{(first|last|f|l|firstinitial|lastinitial|mi)\}/i.test(local)) {
      return NextResponse.json({ error: "pattern must include a name token like {first} or {last}" }, { status: 422 });
    }
    const client = await repo.setUsernamePattern(params.slug, local);
    await repo.writeAudit({ actor: "ui", action: "client.username_pattern.set", clientId: client.id, detail: { pattern: local } });
    return NextResponse.json(client);
  }

  // Hard refresh: overwrite this client's SN-owned fields from ServiceNow, discarding manual edits.
  if (body.action === "hard-refresh") {
    try {
      const res = await hardRefreshClient(db, params.slug, "ui");
      if (!res.ok) return NextResponse.json({ error: res.reason }, { status: res.reason === "not found" ? 404 : 422 });
      return NextResponse.json(res);
    } catch (e) {
      const msg = e instanceof SnGatewayError ? `ServiceNow: ${e.message}` : (e as Error).message;
      return NextResponse.json({ error: `hard refresh failed: ${msg}` }, { status: 502 });
    }
  }

  // Inline table edit: the backbone (or "" / null to clear).
  if (body.action === "set-backbone") {
    let backbone: Backbone | null;
    if (body.backbone === null || body.backbone === "") backbone = null;
    else if (typeof body.backbone === "string" && BACKBONES.includes(body.backbone)) backbone = body.backbone as Backbone;
    else return NextResponse.json({ error: `backbone must be one of ${BACKBONES.join(", ")} (or empty)` }, { status: 422 });
    const client = await repo.setBackbone(params.slug, backbone);
    await repo.writeAudit({ actor: "ui", action: "client.backbone.set", clientId: client.id, detail: { backbone } });
    return NextResponse.json(client);
  }

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

  // Mark the client internal (incident intake) vs external (UM intake) — drives case scanning.
  if (body.action === "set-intake-source") {
    const src = body.intakeSource;
    if (src !== "um" && src !== "incident") return NextResponse.json({ error: 'intakeSource must be "um" or "incident"' }, { status: 422 });
    const client = await repo.setIntakeSource(params.slug, src);
    await repo.writeAudit({ actor: "ui", action: "client.intake_source.set", clientId: client.id, detail: { intakeSource: src } });
    return NextResponse.json(client);
  }

  if (body.action !== "archive" && body.action !== "restore") {
    return NextResponse.json(
      { error: 'action must be one of: archive, restore, set-domain, set-backbone, set-email-domain, set-intake-source, hard-refresh' },
      { status: 422 }
    );
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
