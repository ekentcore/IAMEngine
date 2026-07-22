// The two fleet sweeps, as one implementation.
//
// Both walk every wired m365-admin credential, resolve it from Delinea, do the same
// client-credentials grant the runner does, and read from Graph. They live here rather than in the
// scripts because /fleet-audit and `npx tsx scripts/audit-*.ts` must never be able to disagree: a report
// that says something different depending on how you ran it is worse than no report.
//
// Read-only throughout. Returns verdicts, permission NAMES and UPNs — never a credential value.
import type { PrismaClient } from "@prisma/client";
import { delineaConfigFromEnv, delineaConfigured, getDelineaToken, resolveSecretFields } from "../secrets/delinea";
import {
  classifyM365Credential,
  acquireGraphToken,
  pickField,
  M365_APPID_FIELDS,
  M365_SECRET_FIELDS,
  M365_TENANT_FIELDS,
} from "../secrets/m365-credential";
import { readGrantedAppRoles, listDisabledLicensedUsers, readSkuNames, readMailboxPurpose } from "../secrets/graph-app-roles";
import { graphCapGaps, graphCapRows, graphSurplusRoles, suggestedRole } from "../secrets/graph-caps";
import type { SurplusRole } from "../secrets/graph-caps";

// The "not set" sentinels every secret sweep skips. An empty slot is not a finding.
const UNSET = ["", "REPLACE_ME", "NOT_NEEDED"];

export type AuditStatus = "ok" | "gaps" | "unverified" | "cred-bad" | "no-cred";

export type PermissionRow = {
  clientId: string;
  client: string;
  slug: string;
  status: AuditStatus;
  granted: string[];
  missingRequired: string[];
  missingOptional: string[];
  // Authority the credential holds that the engine never needs — the opposite question to "missing",
  // and the one a client's security team asks. Escalation-capable roles sort first. Advisory only:
  // it never changes `status`, because a permission we don't use is not a fault in OUR setup, and the
  // app registration may be shared with tooling that is none of our business.
  //
  // Safe on an incomplete read, unlike `missing`: an unresolved role is simply absent from `granted`,
  // and absence can only make a broad role look load-bearing — i.e. UNDER-report surplus, never
  // invent one. (The reverse is why `missing` needs the "unverified" branch below.)
  surplus: SurplusRole[];
  detail?: string;
};

export type LeakRow = {
  clientId: string;
  client: string;
  slug: string;
  displayName: string;
  userPrincipalName: string;
  licenses: string[];
  mailbox: "shared" | "not-shared" | "unknown";
};

// What you may safely do about a leaked seat, and why. One function so the "what" cannot drift from
// the "why" — pulling a licence off a mailbox that was never converted is destructive.
export function leakVerdict(mailbox: LeakRow["mailbox"]): string {
  if (mailbox === "shared") return "safe to remove the licence — the mailbox is already shared";
  if (mailbox === "not-shared") return "convert the mailbox FIRST — removing the licence now lets Exchange purge it after its 30-day grace";
  return "unknown mailbox state — grant MailboxSettings.Read (or check in EXO) before acting";
}

type Target = { clientId: string; client: string; slug: string; externalId: string; primaryDomain: string | null };

// Every client with a usable m365-admin reference.
export async function auditTargets(db: PrismaClient, onlyClient?: string): Promise<Target[]> {
  const rows = await db.secret.findMany({
    where: {
      name: "m365-admin",
      externalId: { notIn: UNSET },
      client: onlyClient ? { OR: [{ slug: onlyClient }, { coreId: onlyClient }], archivedAt: null } : { archivedAt: null },
    },
    select: { externalId: true, client: { select: { id: true, name: true, slug: true, primaryDomain: true } } },
    orderBy: { client: { name: "asc" } },
  });
  return rows.map((r) => ({ clientId: r.client.id, client: r.client.name, slug: r.client.slug, externalId: r.externalId, primaryDomain: r.client.primaryDomain }));
}

// Resolve a target's credential and mint a Graph token, or explain why we can't.
async function tokenFor(
  t: Target,
  cfg: ReturnType<typeof delineaConfigFromEnv>,
  dToken: string
): Promise<{ ok: true; token: string; appId: string } | { ok: false; status: AuditStatus; detail: string }> {
  const resolved = await resolveSecretFields(cfg, t.externalId, undefined, dToken);
  if (!resolved.ok || !resolved.fields) return { ok: false, status: "no-cred", detail: resolved.error ?? "could not resolve the secret" };
  // A Global Admin account can never authenticate the client-credentials flow — don't spend a round
  // trip proving it (see m365-credential.ts).
  const kind = classifyM365Credential(resolved.fields);
  if (kind.kind !== "app-registration") return { ok: false, status: "cred-bad", detail: kind.reason };
  const appId = pickField(resolved.fields, M365_APPID_FIELDS)!;
  const secret = pickField(resolved.fields, M365_SECRET_FIELDS)!;
  const tenant = pickField(resolved.fields, M365_TENANT_FIELDS) ?? t.primaryDomain ?? undefined;
  if (!tenant) return { ok: false, status: "cred-bad", detail: "no TenantId/Domain field, and the client has no primary domain to fall back on" };
  const tok = await acquireGraphToken(tenant, appId, secret);
  if (!tok.ok || !tok.token) return { ok: false, status: "cred-bad", detail: `Entra rejected this credential (${tok.errorCode ?? tok.error})${tok.hint ? ` — ${tok.hint}` : ""}` };
  return { ok: true, token: tok.token, appId };
}

export type Progress = (done: number) => Promise<void> | void;

// WHO IS MISSING A PERMISSION.
export async function scanPermissions(db: PrismaClient, opts: { onlyClient?: string; onProgress?: Progress } = {}): Promise<PermissionRow[]> {
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) throw new Error("Delinea is not configured (DELINEA_BASE_URL / DELINEA_USER / DELINEA_PASSWORD)");
  // ONE Delinea token for the whole sweep — a password grant per client trips its rate limits.
  const dToken = await getDelineaToken(cfg);
  const targets = await auditTargets(db, opts.onlyClient);
  const out: PermissionRow[] = [];

  for (const [i, t] of targets.entries()) {
    const base = { clientId: t.clientId, client: t.client, slug: t.slug, granted: [] as string[], missingRequired: [] as string[], missingOptional: [] as string[], surplus: [] as SurplusRole[] };
    const tok = await tokenFor(t, cfg, dToken);
    if (!tok.ok) {
      out.push({ ...base, status: tok.status, detail: tok.detail });
      await opts.onProgress?.(i + 1);
      continue;
    }
    const granted = await readGrantedAppRoles(tok.token, tok.appId);
    if (!granted.ok) {
      out.push({ ...base, status: "unverified", detail: `could not read the app's role assignments: ${granted.error}` });
      await opts.onProgress?.(i + 1);
      continue;
    }
    const rows = graphCapRows(granted.roles);
    const missingRequired = rows.filter((r) => !r.optional && !r.ok).map((r) => suggestedRole({ need: r.need, anyOf: r.anyOf }));
    const missingOptional = rows.filter((r) => r.optional && !r.ok).map((r) => suggestedRole({ need: r.need, anyOf: r.anyOf }));
    const surplus = graphSurplusRoles(granted.roles);

    // An INCOMPLETE read cannot support a "missing" claim: the roles may well be granted and simply
    // unreadable this pass (Graph throttles a fleet sweep — that is the PR #90 bug). Say "couldn't
    // verify" and let the operator re-run. Never guess.
    if (!granted.complete && (missingRequired.length || missingOptional.length)) {
      out.push({
        ...base, status: "unverified", granted: granted.roles, missingRequired, missingOptional, surplus,
        detail: `${granted.unresolved} assignment(s) unresolved (Graph throttled the lookup) — re-run to confirm; this is NOT a confirmed gap`,
      });
    } else {
      out.push({ ...base, status: graphCapGaps(granted.roles).length ? "gaps" : "ok", granted: granted.roles, missingRequired, missingOptional, surplus });
    }
    await opts.onProgress?.(i + 1);
  }
  return out;
}

// WHO IS STILL COSTING US MONEY.
export async function scanLeakedSeats(db: PrismaClient, opts: { onlyClient?: string; onProgress?: Progress } = {}): Promise<LeakRow[]> {
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) throw new Error("Delinea is not configured (DELINEA_BASE_URL / DELINEA_USER / DELINEA_PASSWORD)");
  const dToken = await getDelineaToken(cfg);
  const targets = await auditTargets(db, opts.onlyClient);
  const out: LeakRow[] = [];

  for (const [i, t] of targets.entries()) {
    const tok = await tokenFor(t, cfg, dToken);
    if (!tok.ok) { await opts.onProgress?.(i + 1); continue; } // a broken credential is the permission report's story, not this one
    const found = await listDisabledLicensedUsers(tok.token);
    if (found.ok && found.users.length) {
      const skus = await readSkuNames(tok.token);
      for (const u of found.users) {
        const mp = await readMailboxPurpose(tok.token, u.id);
        out.push({
          clientId: t.clientId, client: t.client, slug: t.slug,
          displayName: u.displayName,
          userPrincipalName: u.userPrincipalName,
          licenses: u.skuIds.map((id) => skus.get(id) ?? id),
          // "shared" -> converted. "user" -> not. Anything else (usually a missing
          // MailboxSettings.Read, sometimes no mailbox at all) is unknown, never assumed.
          mailbox: mp.purpose === "shared" ? "shared" : mp.purpose === "user" ? "not-shared" : "unknown",
        });
      }
    }
    await opts.onProgress?.(i + 1);
  }
  return out;
}

// WHO HOLDS an escalation-capable role (AppRoleAssignment.ReadWrite.All and friends) — the INVERSE of
// the missing-permission sweep: not "who is short a permission" but "which app registrations can
// expand their own authority / reach the whole tenant". Same read-only walk as scanPermissions; the
// finding is the escalation roles each credential actually holds (via graphSurplusRoles, which flags
// them). A credential we can't read is reported as unverified, never silently treated as "holds none".
export type EscalationHolderRow = {
  clientId: string;
  client: string;
  slug: string;
  status: AuditStatus; // ok | cred-bad | no-cred | unverified
  escalations: SurplusRole[]; // the escalation roles this credential holds (escalation === true)
  detail?: string;
};

export async function scanEscalationHolders(db: PrismaClient, opts: { onlyClient?: string; onProgress?: Progress } = {}): Promise<EscalationHolderRow[]> {
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) throw new Error("Delinea is not configured (DELINEA_BASE_URL / DELINEA_USER / DELINEA_PASSWORD)");
  const dToken = await getDelineaToken(cfg);
  const targets = await auditTargets(db, opts.onlyClient);
  const out: EscalationHolderRow[] = [];

  for (const [i, t] of targets.entries()) {
    const base = { clientId: t.clientId, client: t.client, slug: t.slug, escalations: [] as SurplusRole[] };
    const tok = await tokenFor(t, cfg, dToken);
    if (!tok.ok) { out.push({ ...base, status: tok.status, detail: tok.detail }); await opts.onProgress?.(i + 1); continue; }
    const granted = await readGrantedAppRoles(tok.token, tok.appId);
    if (!granted.ok) { out.push({ ...base, status: "unverified", detail: `could not read the app's role assignments: ${granted.error}` }); await opts.onProgress?.(i + 1); continue; }
    // A held escalation role is present in `granted` regardless of read completeness — absence can only
    // UNDER-report a holder, never invent one — so this is safe on a partial read (unlike "missing").
    const escalations = graphSurplusRoles(granted.roles).filter((s) => s.escalation);
    out.push({ ...base, status: "ok", escalations, detail: granted.complete ? undefined : `${granted.unresolved} assignment(s) unresolved — a held role may be under-reported` });
    await opts.onProgress?.(i + 1);
  }
  return out;
}

export type EscalationPivot = { role: string; why: string; clients: { slug: string; client: string }[] };

// Pivot escalation-holder rows into "who holds THIS role" — the direct answer to "who has
// AppRoleAssignment.ReadWrite.All". AppRoleAssignment.ReadWrite.All sorts first (the tenant-takeover
// route), then by holder count.
export function pivotEscalationHolders(rows: EscalationHolderRow[]): EscalationPivot[] {
  const byRole = new Map<string, { why: string; clients: { slug: string; client: string }[] }>();
  for (const r of rows) {
    for (const s of r.escalations) {
      const e = byRole.get(s.role) ?? { why: s.why, clients: [] };
      e.clients.push({ slug: r.slug, client: r.client });
      byRole.set(s.role, e);
    }
  }
  const SELF_GRANT = "approleassignment.readwrite.all";
  return [...byRole]
    .map(([role, e]) => ({ role, why: e.why, clients: e.clients }))
    .sort((a, b) =>
      Number(b.role.toLowerCase() === SELF_GRANT) - Number(a.role.toLowerCase() === SELF_GRANT) ||
      b.clients.length - a.clients.length ||
      a.role.localeCompare(b.role)
    );
}

export type PermissionPivot = { role: string; optional: boolean; clients: { slug: string; client: string }[] };

// Pivot the per-client rows into "who needs THIS permission" — the question the per-client connection
// test cannot answer, and the reason this page exists.
//
// `unverified` rows are excluded on purpose: an unconfirmed gap must never reach a to-do list. They
// are surfaced separately as "re-run these".
export function pivotByPermission(rows: PermissionRow[]): PermissionPivot[] {
  const byRole = new Map<string, { optional: boolean; clients: { slug: string; client: string }[] }>();
  for (const r of rows) {
    if (r.status === "unverified") continue;
    for (const [roles, optional] of [[r.missingRequired, false], [r.missingOptional, true]] as const) {
      for (const role of roles) {
        const e = byRole.get(role) ?? { optional, clients: [] };
        e.clients.push({ slug: r.slug, client: r.client });
        byRole.set(role, e);
      }
    }
  }
  // Required first (they break things), then by blast radius.
  return [...byRole]
    .map(([role, e]) => ({ role, optional: e.optional, clients: e.clients }))
    .sort((a, b) => Number(a.optional) - Number(b.optional) || b.clients.length - a.clients.length || a.role.localeCompare(b.role));
}
