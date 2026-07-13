// Structured credential-failure classification. The broker is the ONE place that knows exactly why
// a credential couldn't be handed to the runner, so it stamps a machine-readable record on the Job;
// recordResult copies it onto the RunOutcome row. Remediation scripts then act on `code` (+ the
// secretName/externalId) instead of parsing free-text error strings. Values here are metadata only —
// never a secret value.

export type CredFailureCode =
  | "reference_missing" // no Delinea reference wired for this secret name (client, parent, or override)
  | "not_needed" // the secret is marked not-needed/manual, yet an executor asked for it (config drift)
  | "not_authorized" // the job's secretNames allow-list doesn't include the requested name
  | "delinea_not_configured" // the app has no DELINEA_* env — nothing can be resolved/pushed down
  | "delinea_not_found" // the wired reference id doesn't resolve (deleted/typo'd secret)
  | "delinea_denied" // the app's Delinea account can't read the secret (folder/secret permissions)
  | "delinea_unresolvable" // Delinea errored some other way (timeout, 5xx, malformed)
  | "otp_unavailable"; // a one-time password was requested but Delinea couldn't mint one

export type CredFailure = {
  code: CredFailureCode;
  secretName: string;
  detail: string; // human sentence (never a secret value)
  fix: string; // the actionable remediation — what a script or operator changes
  externalId?: string; // the Delinea reference involved, when one exists
  source?: string; // where the reference came from: own | parent | override
  at: string; // ISO timestamp of the failed broker attempt
};

// Sub-classify a resolveSecretFields error message into the scriptable buckets. The resolver's
// messages are stable app-side strings that embed the Delinea HTTP status.
export function classifyDelineaError(message: string): Extract<CredFailureCode, "delinea_not_found" | "delinea_denied" | "delinea_unresolvable"> {
  const m = message.toLowerCase();
  if (/\b404\b|not found|does not exist|no such secret/.test(m)) return "delinea_not_found";
  if (/\b401\b|\b403\b|access denied|denied|permission|unauthoriz/.test(m)) return "delinea_denied";
  return "delinea_unresolvable";
}

export function credFailure(
  code: CredFailureCode,
  secretName: string,
  detail: string,
  extra: { externalId?: string; source?: string } = {}
): CredFailure {
  const FIX: Record<CredFailureCode, string> = {
    reference_missing: `wire a Delinea reference named '${secretName}' on the client (or override it on the case)`,
    not_needed: `either mark the system's secret as needed again, or remove '${secretName}' from the job's secretNames`,
    not_authorized: `add '${secretName}' to the system's secretNames so jobs may request it`,
    delinea_not_configured: "set DELINEA_* on the app server so it can resolve and push credentials",
    delinea_not_found: `re-wire '${secretName}' to a live Delinea secret — the current reference doesn't resolve`,
    delinea_denied: `grant the app's Delinea account Read on the secret (or its folder)`,
    delinea_unresolvable: "check Delinea availability, then re-run — the reference may be fine",
    otp_unavailable: "enable One-Time Password on the Delinea secret (paste the authenticator seed there once)",
  };
  return { code, secretName, detail, fix: FIX[code], at: new Date().toISOString(), ...extra };
}
