// Per-case credential resolution + "where does this step run" helpers. The credential broker prefers
// a case-level override (a one-off / fill-in reference) over the client's default; both are Delinea
// REFERENCES (ids), never values. Pure functions here are unit-tested; DB-touching status lives in
// case-secrets-repo.

export type SecretSource = "case" | "client" | "missing" | "not_needed";

// Sentinel reference meaning "this module is handled as a manual step — don't require a credential."
// Stored as a secret's externalId so it travels with the client wiring (and can be set as a case
// override). The broker never resolves it; the preflight treats it as satisfied, not missing.
export const NOT_NEEDED = "NOT_NEEDED";

// Extract a server/host hint from a secret label, e.g. "Domain controller (core-cce-dc01) admin"
// -> "core-cce-dc01". Returns null when the label names no host.
export function serverHintFromLabel(label?: string | null): string | null {
  if (!label) return null;
  const m = label.match(/\(([^)]+)\)/);
  if (!m) return null;
  const h = m[1].trim();
  // A hostname has a dot or hyphen and NO whitespace ("core-cce-dc01"); a parenthetical like
  // "On-Boarding Script" (an app name) is not a server.
  return h && !/\s/.test(h) && /[.-]/.test(h) ? h : null;
}

const ONPREM_SYSTEMS = new Set(["active-directory", "directory-sync"]);

// Human label for where a step executes: on-prem systems run on the client-network agent (named
// server if the secret label gives one); cloud systems on the central runner; servicenow/case
// resolution are app/manual.
export function stepRunsOn(systemKey: string, backbone: string | null | undefined, serverHints: string[]): string {
  const onPrem = ONPREM_SYSTEMS.has(systemKey) || (systemKey === "exchange" && !!backbone && backbone.startsWith("ad"));
  const where = onPrem
    ? "Client-network agent"
    : systemKey === "servicenow" || systemKey === "case-resolution"
      ? "App / manual"
      : "Central / cloud runner";
  const server = serverHints.map((s) => s.trim()).filter(Boolean)[0];
  return server ? `${where} · ${server}` : where;
}

// Preflight: which of a job's required secrets have NO usable reference (case override > client
// default, both missing/REPLACE_ME). A non-empty result means the job can't run — the broker can't
// hand the runner a credential — so it shouldn't be claimed. clientSecretByName maps the client's
// secret name -> its stored externalId.
export function missingRequiredSecrets(
  secretNames: string[] | undefined,
  overrides: unknown,
  clientSecretByName: Map<string, string | null>
): string[] {
  const missing: string[] = [];
  for (const name of secretNames ?? []) {
    const { externalId, source } = effectiveExternalId(name, overrides, clientSecretByName.get(name) ?? null);
    // "not needed" is intentional (manual-step module) — satisfied, not missing.
    if (!externalId && source !== "not_needed") missing.push(name);
  }
  return missing;
}

// The reference the broker should use for a secret on this case: a case override wins over the
// client default; null when neither is set (the step can't run until it's filled).
export function effectiveExternalId(
  name: string,
  overrides: unknown,
  clientExternalId: string | null | undefined
): { externalId: string | null; source: SecretSource } {
  const o = overrides && typeof overrides === "object" ? (overrides as Record<string, unknown>)[name] : undefined;
  // A case override wins — including an override that marks the secret not-needed for this case.
  if (typeof o === "string" && o.trim() === NOT_NEEDED) return { externalId: null, source: "not_needed" };
  if (typeof o === "string" && o.trim() && o.trim() !== "REPLACE_ME") return { externalId: o.trim(), source: "case" };
  // Client-level "not needed" marker (module is a manual step).
  if (typeof clientExternalId === "string" && clientExternalId.trim() === NOT_NEEDED) return { externalId: null, source: "not_needed" };
  if (typeof clientExternalId === "string" && clientExternalId.trim() && clientExternalId.trim() !== "REPLACE_ME") {
    return { externalId: clientExternalId.trim(), source: "client" };
  }
  return { externalId: null, source: "missing" };
}
