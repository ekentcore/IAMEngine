// GET   /api/clients/:slug — client detail (systems + secrets).
// PATCH /api/clients/:slug — { action: "archive" | "restore" | "set-email-domain" }.
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { Prisma, type Backbone } from "@prisma/client";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import { normalizeDomainInput } from "@/lib/clients/email-domain";
import { hardRefreshClient } from "@/lib/clients/hard-refresh";
import { refreshClientName } from "@/lib/clients/refresh-name";
import { refreshClientLocations } from "@/lib/clients/refresh-locations";
import { SnGatewayError } from "@/lib/servicenow/gateway";
import { parseClientOverride } from "@/lib/notifications/types";

const BACKBONES = ["entra", "google", "ad_synced", "ad_standalone"];

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  const repo = makeClientRepository(db);
  // scope-gated: an out-of-scope client reads as not-found.
  const client = await repo.getClientBySlug(params.slug, await currentClientScope(db));
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(client);
}

export async function PATCH(req: Request, { params }: Ctx) {
  let body: { action?: string; domain?: unknown; lock?: unknown; backbone?: unknown; pattern?: unknown; intakeSource?: unknown; domains?: unknown; restricted?: unknown; runCloudOnOwnAgent?: unknown; engineOptOut?: unknown; inherit?: unknown; copy?: unknown; override?: unknown; name?: unknown; groups?: unknown; ou?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  // Restricting a client is the most sensitive access-control decision (it hides an org from everyone
  // but super admins) — SUPER-ADMIN ONLY. Everything else on this route is the usual systems-editing
  // capability.
  const _g = body.action === "set-restricted" ? await guardAuth() : await guard("client.edit_systems");
  if (_g.res) return _g.res;
  if (body.action === "set-restricted" && _g.user.role !== "super_admin") {
    return NextResponse.json({ error: "only a super admin can restrict or unrestrict a client" }, { status: 403 });
  }

  const repo = makeClientRepository(db);
  // scope-gated: you can only edit a client you can see (an out-of-scope client reads as not-found).
  const existing = await repo.getClientBySlug(params.slug, await currentClientScope(db));
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Pull just the name from ServiceNow (a renamed account, e.g. CORE2224) — narrow, doesn't touch
  // edits or other fields like a hard refresh does.
  if (body.action === "refresh-name") {
    try {
      const r = await refreshClientName(db, params.slug, _g.user.email || "ui");
      if (!r.ok) return NextResponse.json({ error: r.reason ?? "couldn't refresh the name" }, { status: 422 });
      return NextResponse.json(r);
    } catch (e) {
      if (e instanceof SnGatewayError) return NextResponse.json({ error: `ServiceNow: ${e.message}` }, { status: 502 });
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }
  }

  if (body.action === "refresh-locations") {
    try {
      const r = await refreshClientLocations(db, params.slug, _g.user.email || "ui");
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 422 });
      return NextResponse.json(r);
    } catch (e) {
      if (e instanceof SnGatewayError) return NextResponse.json({ error: `ServiceNow: ${e.message}` }, { status: 502 });
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }
  }

  // Inline table edit: the website domain.
  if (body.action === "set-domain") {
    const domain = normalizeDomainInput(typeof body.domain === "string" ? body.domain : "");
    if (!domain) return NextResponse.json({ error: "domain must be a domain like acme.com" }, { status: 422 });
    const client = await repo.setPrimaryDomain(params.slug, domain);
    await repo.writeAudit({ actor: _g.user.email || "ui", action: "client.domain.set", clientId: client.id, detail: { primaryDomain: domain } });
    return NextResponse.json(client);
  }

  // Inline table edit: the email/UPN name format. Accepts "primary | fallback" — the fallback is
  // used when the primary UPN is taken by a different person (e.g. "{first}.{last} | {first}.{mi}").
  if (body.action === "set-domains") {
    const raw = Array.isArray(body.domains) ? body.domains : null;
    if (!raw) return NextResponse.json({ error: "domains[] is required" }, { status: 422 });
    const domains: string[] = [];
    for (const d of raw) {
      const n = normalizeDomainInput(typeof d === "string" ? d : "");
      if (!n) return NextResponse.json({ error: `'${String(d)}' is not a valid domain` }, { status: 422 });
      if (!domains.includes(n)) domains.push(n);
    }
    const updated = await repo.setDomains(params.slug, domains);
    await repo.writeAudit({ actor: "ui", action: "client.domains.set", clientId: updated.id, detail: { domains } });
    return NextResponse.json({ ok: true, domains });
  }

  if (body.action === "set-username-pattern") {
    const raw = typeof body.pattern === "string" ? body.pattern.trim() : "";
    const NAME_TOKEN = /\{(first|last|f|l|firstinitial|lastinitial|mi)\}/i;
    const parts = raw.split("|").map((s) => s.trim().split("@")[0].trim()).filter(Boolean); // accept full patterns or local parts
    if (parts.length === 0) return NextResponse.json({ error: "a username pattern is required" }, { status: 422 });
    for (const p of parts) {
      if (!NAME_TOKEN.test(p)) return NextResponse.json({ error: `each pattern must include a name token like {first} or {last}: "${p}"` }, { status: 422 });
    }
    const client = await repo.setUsernamePattern(params.slug, parts[0], parts.slice(1));
    await repo.writeAudit({ actor: _g.user.email || "ui", action: "client.username_pattern.set", clientId: client.id, detail: { pattern: parts[0], fallbacks: parts.slice(1) } });
    return NextResponse.json(client);
  }

  // Hard refresh: overwrite this client's SN-owned fields from ServiceNow, discarding manual edits.
  if (body.action === "hard-refresh") {
    try {
      const res = await hardRefreshClient(db, params.slug, _g.user.email || "ui");
      if (!res.ok) return NextResponse.json({ error: res.reason }, { status: res.reason === "not found" ? 404 : 422 });
      return NextResponse.json(res);
    } catch (e) {
      const msg = e instanceof SnGatewayError ? `ServiceNow: ${e.message}` : (e as Error).message;
      return NextResponse.json({ error: `hard refresh failed: ${msg}` }, { status: 502 });
    }
  }

  // Location AD/Entra targets: set the groups (+ optional OU) a matched location adds. Merges into the
  // existing Client.locations entry (keeps city/state/timezone/…). Applied at plan time (plan-resolve).
  if (body.action === "set-location-targets") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "location name required" }, { status: 422 });
    const groups = Array.isArray(body.groups) ? body.groups.filter((g): g is string => typeof g === "string" && g.trim() !== "").map((g) => g.trim()) : [];
    const ou = typeof body.ou === "string" ? body.ou.trim() : "";
    const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true, locations: true } });
    if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
    const locs = client.locations && typeof client.locations === "object" && !Array.isArray(client.locations)
      ? { ...(client.locations as Record<string, Record<string, unknown>>) } : {};
    if (!locs[name]) return NextResponse.json({ error: `no location named "${name}"` }, { status: 422 });
    const entry = { ...locs[name] };
    if (groups.length) entry.groups = groups; else delete entry.groups;
    if (ou) entry.ou = ou; else delete entry.ou;
    locs[name] = entry;
    await db.client.update({ where: { id: client.id }, data: { locations: locs as Prisma.InputJsonValue } });
    await repo.writeAudit({ actor: _g.user.email || "ui", action: "client.location_targets.set", clientId: client.id, detail: { name, groups: groups.length, ou: ou || null } });
    return NextResponse.json({ ok: true });
  }

  // Inline table edit: the backbone (or "" / null to clear).
  if (body.action === "set-backbone") {
    let backbone: Backbone | null;
    if (body.backbone === null || body.backbone === "") backbone = null;
    else if (typeof body.backbone === "string" && BACKBONES.includes(body.backbone)) backbone = body.backbone as Backbone;
    else return NextResponse.json({ error: `backbone must be one of ${BACKBONES.join(", ")} (or empty)` }, { status: 422 });
    const client = await repo.setBackbone(params.slug, backbone);
    await repo.writeAudit({ actor: _g.user.email || "ui", action: "client.backbone.set", clientId: client.id, detail: { backbone } });
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
      actor: _g.user.email || "ui",
      action: "client.email_domain.set",
      clientId: client.id,
      detail: { emailDomain: domain, locked: lock },
    });
    return NextResponse.json(client);
  }

  // Mark the client internal-only (restricted): hidden from operators not granted it. Access-control
  // decision — guarded above on user.manage.
  if (body.action === "set-restricted") {
    if (typeof body.restricted !== "boolean") return NextResponse.json({ error: "restricted must be a boolean" }, { status: 422 });
    const client = await repo.setRestricted(params.slug, body.restricted);
    await repo.writeAudit({ actor: _g.user.email || "ui", action: "client.restricted.set", clientId: client.id, detail: { restricted: body.restricted } });
    return NextResponse.json(client);
  }

  // Run this client's cloud jobs on its own agent (when it has one) rather than the central runner.
  if (body.action === "set-run-cloud-on-own-agent") {
    if (typeof body.runCloudOnOwnAgent !== "boolean") return NextResponse.json({ error: "runCloudOnOwnAgent must be a boolean" }, { status: 422 });
    const client = await repo.setRunCloudOnOwnAgent(params.slug, body.runCloudOnOwnAgent);
    await repo.writeAudit({ actor: _g.user.email || "ui", action: "client.run_cloud_on_own_agent.set", clientId: client.id, detail: { runCloudOnOwnAgent: body.runCloudOnOwnAgent } });
    return NextResponse.json(client);
  }

  // "Do not use engine": stop importing this client's ServiceNow cases (sweep + manual import).
  if (body.action === "set-engine-opt-out") {
    if (typeof body.engineOptOut !== "boolean") return NextResponse.json({ error: "engineOptOut must be a boolean" }, { status: 422 });
    const client = await repo.setEngineOptOut(params.slug, body.engineOptOut);
    await repo.writeAudit({ actor: _g.user.email || "ui", action: "client.engine_opt_out.set", clientId: client.id, detail: { engineOptOut: body.engineOptOut } });
    return NextResponse.json(client);
  }

  // Break/restore the parent-systems inheritance for a child that doesn't match its parent.
  // When breaking with { copy: true }, the parent's modeling is materialized onto the child FIRST
  // (so the operator can then edit the steps that differ); { copy: false } leaves the child empty.
  if (body.action === "set-parent-inheritance") {
    if (typeof body.inherit !== "boolean") return NextResponse.json({ error: "inherit must be a boolean" }, { status: 422 });
    if (!existing.parentId) return NextResponse.json({ error: "this client has no parent to inherit from" }, { status: 422 });
    let copied = 0;
    if (!body.inherit && body.copy === true) {
      const r = await repo.copyParentModeling(params.slug);
      // Nothing to carry over (the parent isn't modeled, or the child already has its own systems)
      // is NOT a reason to refuse the break — otherwise the flag never flips and the badge sticks on
      // "inherits". Only a genuinely broken request (missing client/parent) is an error.
      if (!r.ok && (r.code === "not_found" || r.code === "no_parent")) {
        return NextResponse.json({ error: r.code === "not_found" ? "client not found" : "this client has no parent to inherit from" }, { status: 422 });
      }
      copied = r.ok ? r.copied : 0;
    }
    const client = await repo.setInheritParentSystems(params.slug, body.inherit);
    await repo.writeAudit({
      actor: _g.user.email || "ui",
      action: "client.inherit_parent_systems.set",
      clientId: client.id,
      detail: { inheritParentSystems: body.inherit, copiedSystems: copied },
    });
    return NextResponse.json({ ...client, copiedSystems: copied });
  }

  // Per-client notification override: this client's own destination per channel, added to ("also") or
  // replacing ("only") the resolved base. Send { override: null } (or an empty object) to clear it.
  if (body.action === "set-notify-override") {
    const value = parseClientOverride(body.override); // sanitizes per channel; drops empties
    const channels = Object.keys(value);
    const client = await repo.setNotifyOverride(params.slug, channels.length ? value : null);
    await repo.writeAudit({ actor: _g.user.email || "ui", action: "client.notify_override.set", clientId: client.id, detail: { channels } }); // never the URLs/tokens/recipients
    return NextResponse.json(client);
  }

  // Mark the client internal (incident intake) vs external (UM intake) — drives case scanning.
  if (body.action === "set-intake-source") {
    const src = body.intakeSource;
    if (src !== "um" && src !== "incident") return NextResponse.json({ error: 'intakeSource must be "um" or "incident"' }, { status: 422 });
    const client = await repo.setIntakeSource(params.slug, src);
    await repo.writeAudit({ actor: _g.user.email || "ui", action: "client.intake_source.set", clientId: client.id, detail: { intakeSource: src } });
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
    actor: _g.user.email || "ui",
    action: body.action === "archive" ? "client.archive" : "client.restore",
    clientId: client.id,
    detail: { name: client.name },
  });
  return NextResponse.json(client);
}
