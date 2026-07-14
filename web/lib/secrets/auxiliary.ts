// Attaching OPTIONAL secrets to the work that needs them. See ./optional-secrets for WHICH secrets are
// optional and the invariant that makes this careful ("every name in a job's secretNames is REQUIRED").
import { secretIsSet } from "./wiring";
import { OPTIONAL_SECRETS } from "./optional-secrets";

type SecretRef = { name: string; externalId?: string | null };

// The optional secrets for a system that this client has ACTUALLY wired (a real Delinea reference —
// not blank, not REPLACE_ME, not the not-needed sentinel). Unwired ones are omitted entirely: that is
// what keeps the job claimable and the connection test green for a client that doesn't use the
// capability at all.
export function wiredOptionalSecrets(systemKey: string, clientSecrets: SecretRef[]): string[] {
  const optional = OPTIONAL_SECRETS[systemKey];
  if (!optional?.length) return [];
  const wired = new Set(clientSecrets.filter((s) => secretIsSet(s.externalId)).map((s) => s.name));
  return optional.filter((n) => wired.has(n));
}
