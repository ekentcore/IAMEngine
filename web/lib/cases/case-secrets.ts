// Per-case credential resolution + "where does this step run" helpers. The credential broker prefers
// a case-level override (a one-off / fill-in reference) over the client's default; both are Delinea
// REFERENCES (ids), never values. Pure functions here are unit-tested; DB-touching status lives in
// case-secrets-repo.

export type SecretSource = "case" | "client" | "missing";

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

// The reference the broker should use for a secret on this case: a case override wins over the
// client default; null when neither is set (the step can't run until it's filled).
export function effectiveExternalId(
  name: string,
  overrides: unknown,
  clientExternalId: string | null | undefined
): { externalId: string | null; source: SecretSource } {
  const o = overrides && typeof overrides === "object" ? (overrides as Record<string, unknown>)[name] : undefined;
  if (typeof o === "string" && o.trim() && o.trim() !== "REPLACE_ME") return { externalId: o.trim(), source: "case" };
  if (typeof clientExternalId === "string" && clientExternalId.trim() && clientExternalId.trim() !== "REPLACE_ME") {
    return { externalId: clientExternalId.trim(), source: "client" };
  }
  return { externalId: null, source: "missing" };
}
