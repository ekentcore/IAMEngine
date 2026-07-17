// Test a credential's RAW FIELD VALUES before they're written to Delinea — the "confirm it's working"
// step in the guided setup, so the app only creates a vault secret from credentials that actually work.
//
// This is a registry keyed by secretName: adding a system = adding one entry. Two kinds of prover:
//
//   BLOCKING (live)  — the app can prove the credential itself is good/bad from here (M365: run the
//                      exact OAuth client-credentials grant the runner uses). A failure REFUSES the
//                      write — there's no point vaulting a credential we just proved can't authenticate.
//   ADVISORY (agent) — the app CAN'T reach the target (on-prem AD), so the pre-write check is whether
//                      the client's own runner is reachable + capable. A failure is surfaced but does
//                      NOT block the write: the secret must exist in Delinea before the runner can do
//                      the real bind (validated by the connection test that runs after the write).
//
// Values are used only to produce a verdict — never returned, never logged. The module is DB-free: the
// ad-dc agent check is injected as `ctx.agentReach` so the pure registry unit-tests without Prisma.
import {
  classifyM365Credential,
  pickField,
  M365_APPID_FIELDS,
  M365_SECRET_FIELDS,
  M365_TENANT_FIELDS,
  probeEntraClientCredentials,
} from "@/lib/secrets/m365-credential";

export type ValueProbe = {
  probeable: boolean; // is there a prover for this secret? false → caller writes, runner verifies later
  blocking: boolean; // should a failed probe REFUSE the vault write?
  ok?: boolean; // verdict — present only when probeable
  error?: string; // why it failed (operator-facing)
  hint?: string; // one-line remediation, when we have one
  label?: string; // short success summary
  kind?: "live" | "agent"; // how it was tested — drives the UI copy
};

// Injected context so this module stays DB-free and pure-testable.
export type ProbeCtx = {
  clientPrimaryDomain?: string; // fallback tenant for m365 when the secret carries no TenantId/Domain
  // For ad-dc: "is the client's own AD-capable runner reachable right now" (from clientRunnerReachability).
  agentReach?: () => Promise<{ servable: boolean; reason?: string }>;
};

type Prober = (values: Record<string, string>, ctx: ProbeCtx, fetcher: typeof fetch) => Promise<ValueProbe>;

const PROBERS: Record<string, Prober> = {
  // M365 admin — the definitive live test: the same client-credentials grant Connect-CtgM365 runs. A
  // Global-Admin account (UPN username) is caught before we even hit the network (it can NEVER work).
  "m365-admin": async (values, ctx, fetcher) => {
    const appId = pickField(values, M365_APPID_FIELDS);
    const secret = pickField(values, M365_SECRET_FIELDS);
    if (!appId || !secret) {
      return { probeable: true, blocking: true, ok: false, error: `missing ${!appId ? "app id (Username/appID)" : "client secret (Password/Secret)"}` };
    }
    const cls = classifyM365Credential(values);
    if (cls.kind === "user-account") {
      return {
        probeable: true,
        blocking: true,
        ok: false,
        error: cls.reason,
        hint: "use an app registration's app id (a GUID) + its client secret, not a Global Admin sign-in",
        kind: "live",
      };
    }
    const tenant = pickField(values, M365_TENANT_FIELDS) ?? (ctx.clientPrimaryDomain?.trim() || undefined);
    if (!tenant) {
      return { probeable: true, blocking: true, ok: false, error: "no tenant id/domain, and the client has no primary domain to fall back on", kind: "live" };
    }
    const p = await probeEntraClientCredentials(tenant, appId, secret, fetcher);
    return p.ok
      ? { probeable: true, blocking: true, ok: true, label: "authenticated against Entra", kind: "live" }
      : { probeable: true, blocking: true, ok: false, error: p.error ?? "authentication failed", hint: p.hint, kind: "live" };
  },

  // On-prem AD service account — the app can't bind AD, so the pre-write check is runner comms: is the
  // client's own AD-capable agent online? Advisory (does not block the write). Without an injected
  // reachability probe there's nothing to test → not probeable.
  "ad-dc": async (_values, ctx) => {
    if (!ctx.agentReach) return { probeable: false, blocking: false };
    const r = await ctx.agentReach();
    return r.servable
      ? { probeable: true, blocking: false, ok: true, label: "the client's AD agent is online and capable", kind: "agent" }
      : { probeable: true, blocking: false, ok: false, error: r.reason ?? "no capable AD agent is online for this client", kind: "agent" };
  },
};

// Is there a prover for this secret at all? (Lets the UI decide whether to show a "Test" affordance
// before the create call, without invoking the probe.)
export function isProbeable(secretName: string): boolean {
  return secretName in PROBERS;
}

// Run the prover for a secret over its raw field values. Unknown secret → { probeable:false } so the
// caller writes and lets the runner connection test verify it later.
export async function probeSecretValues(
  secretName: string,
  values: Record<string, string>,
  ctx: ProbeCtx = {},
  fetcher: typeof fetch = fetch,
): Promise<ValueProbe> {
  const prober = PROBERS[secretName];
  if (!prober) return { probeable: false, blocking: false };
  return prober(values, ctx, fetcher);
}
