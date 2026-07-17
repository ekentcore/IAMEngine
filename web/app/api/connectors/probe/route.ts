// POST /api/connectors/probe — replay a HAR capture's GET/HEAD calls with a real credential
// (connector.manage), so the admin learns BEFORE publishing whether the captured API accepts a
// stored credential or is session-cookie-authed (→ browser lane). See lib/connectors/probe.ts for
// the boundaries: read-only methods enforced server-side, response bodies never read, private
// networks refused, statuses only in the response.
//
// The credential comes from either { clientSlug, secretName } (a client's wired secret, resolved
// exactly like the broker resolves it) or a raw { externalId } (a Delinea secret number). Values
// never reach the browser — the probe applies them server-side and returns status codes.
import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { guard } from "@/lib/auth/route-guard";
import { auditActor } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { AUTH_TYPES } from "@/lib/connectors/definition";
import type { ImportedOperation } from "@/lib/connectors/import-har";
import {
  assertProbeHost,
  probeAuthHeaders,
  probeVerdict,
  runProbe,
  splitSafeOps,
  type ProbeAuth,
} from "@/lib/connectors/probe";
import { delineaConfigFromEnv, delineaConfigured, getDelineaToken, resolveSecretFields } from "@/lib/secrets/delinea";

export const dynamic = "force-dynamic";

const MAX_OPS = 30;
// Same list the importer strips: an op header may never smuggle a credential past the auth block.
const AUTH_HEADER_RE = /^(authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|proxy-authorization)$/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseOps(raw: unknown): ImportedOperation[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "ops[] is required — tick at least one operation" };
  if (raw.length > MAX_OPS * 3) return { error: `too many operations (max ${MAX_OPS * 3}) — probe the interesting ones` };
  const ops: ImportedOperation[] = [];
  for (const o of raw) {
    if (!isRecord(o)) return { error: "each op must be an object" };
    const method = typeof o.method === "string" ? o.method.toUpperCase() : "";
    const host = typeof o.host === "string" ? o.host.trim().toLowerCase() : "";
    const path = typeof o.path === "string" ? o.path : "";
    const name = typeof o.suggestedName === "string" && o.suggestedName ? o.suggestedName : `${method.toLowerCase()}-${ops.length + 1}`;
    if (!method || !host || !path.startsWith("/")) return { error: `op '${name}': method, host and a /-rooted path are required` };
    const headers: Record<string, string> = {};
    if (o.headers !== undefined) {
      if (!isRecord(o.headers)) return { error: `op '${name}': headers must be string→string` };
      for (const [k, v] of Object.entries(o.headers)) {
        if (typeof v !== "string") return { error: `op '${name}': headers must be string→string` };
        if (AUTH_HEADER_RE.test(k)) continue; // auth comes from the auth block, never a pasted header
        headers[k] = v;
      }
    }
    ops.push({ suggestedName: name, method, host, path, headers, body: null, responseStatus: null, strippedAuthHeaders: [] });
  }
  return ops;
}

export async function POST(req: Request) {
  const _g = await guard("connector.manage"); if (_g.res) return _g.res;

  let body: { ops?: unknown; auth?: unknown; clientSlug?: unknown; secretName?: unknown; externalId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const ops = parseOps(body.ops);
  if ("error" in ops) return NextResponse.json({ error: ops.error }, { status: 422 });

  if (!isRecord(body.auth) || !AUTH_TYPES.includes(body.auth.type as (typeof AUTH_TYPES)[number])) {
    return NextResponse.json({ error: `auth.type must be one of ${AUTH_TYPES.join(", ")} — set the auth block first` }, { status: 422 });
  }
  const auth = body.auth as ProbeAuth;

  const { safe, skippedUnsafe } = splitSafeOps(ops);
  if (safe.length > MAX_OPS) return NextResponse.json({ error: `too many GET/HEAD operations (${safe.length}, max ${MAX_OPS}) — tick fewer` }, { status: 422 });

  // Every host the probe would touch — including the OAuth tokenUrl, which receives the client
  // secret — must pass the private-network guard before anything is sent anywhere.
  const hosts = [...new Set(safe.map((o) => o.host))];
  if (auth.type === "oauth2-client-credentials" && typeof auth.tokenUrl === "string") {
    try { hosts.push(new URL(auth.tokenUrl).hostname.toLowerCase()); } catch { return NextResponse.json({ error: "auth.tokenUrl is not a valid URL" }, { status: 422 }); }
  }
  const resolver = async (h: string) => (await lookup(h, { all: true })).map((a) => a.address);
  for (const h of [...new Set(hosts)]) {
    try {
      await assertProbeHost(h, resolver);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
    }
  }

  // Resolve the credential (unless probing unauthenticated on purpose).
  let fields: Record<string, string> = {};
  let credRef: { clientSlug?: string; secretName?: string; externalId?: string } = {};
  if (auth.type !== "none") {
    const rawId = typeof body.externalId === "string" ? body.externalId.trim() : "";
    const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug.trim() : "";
    const secretName = typeof body.secretName === "string" ? body.secretName.trim() : "";
    let externalId = "";
    if (rawId) {
      if (!/^\d{1,12}$/.test(rawId)) return NextResponse.json({ error: "externalId must be a Delinea secret number" }, { status: 422 });
      externalId = rawId;
      credRef = { externalId: rawId };
    } else if (clientSlug && secretName) {
      const client = await db.client.findUnique({ where: { slug: clientSlug }, select: { id: true } });
      if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
      const secret = await db.secret.findUnique({ where: { clientId_name: { clientId: client.id, name: secretName } }, select: { externalId: true } });
      if (!secret) return NextResponse.json({ error: `client has no secret named '${secretName}'` }, { status: 404 });
      externalId = secret.externalId;
      credRef = { clientSlug, secretName };
    } else {
      return NextResponse.json({ error: "pick a client + secret, or enter a Delinea secret number (or set auth.type to none to probe unauthenticated)" }, { status: 422 });
    }

    const cfg = delineaConfigFromEnv();
    if (!delineaConfigured(cfg)) return NextResponse.json({ error: "Delinea is not configured on the app (set DELINEA_*)" }, { status: 503 });
    let token: string | undefined;
    try {
      token = await getDelineaToken(cfg);
    } catch (e) {
      return NextResponse.json({ error: `Delinea auth failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }
    const resolved = await resolveSecretFields(cfg, externalId, undefined, token);
    if (!resolved.ok || !resolved.fields) {
      return NextResponse.json({ error: `could not resolve the secret: ${resolved.error ?? "no fields"}` }, { status: 422 });
    }
    fields = resolved.fields;
  }

  const authHeaders = await probeAuthHeaders(auth, fields);
  if ("error" in authHeaders) return NextResponse.json({ error: authHeaders.error }, { status: 422 });

  const fetcher = (url: string, init: { method: string; headers: Record<string, string>; redirect: "manual"; signal?: AbortSignal }) =>
    fetch(url, init).then((r) => ({ status: r.status, headers: r.headers }));
  const results = await runProbe(safe, authHeaders.headers, fetcher);
  const { verdict, note } = probeVerdict(results);

  // A probe SENDS a client credential to a vendor host — squarely an audited act. Statuses and
  // hosts only: never a header, never a field value.
  const who = auditActor(_g.user, "ui");
  await db.auditLog.create({
    data: {
      actor: who.label,
      userId: who.userId,
      action: "connector.probe",
      detail: {
        hosts,
        authType: auth.type,
        ...credRef,
        probed: results.map((r) => ({ name: r.name, method: r.method, status: r.status })),
        skippedUnsafe,
        verdict,
      },
    },
  }).catch(() => { /* the probe result still returns; the audit failure is the server log's problem */ });

  return NextResponse.json({ results, skippedUnsafe, verdict, note });
}
