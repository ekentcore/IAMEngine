// Builds the POST body's `values` object for the guided API-setup "paste fields" flow
// (GuidedApiSetup), keyed by each field requirement's CANONICAL synonym (`f.anyOf[0]`) rather than
// its human `label`.
//
// checkFieldShape (field-requirements.ts) and pickField (m365-credential.ts) both match a secret's
// Delinea field NAMES against a requirement's `anyOf` synonym list (case/space-insensitive) — a human
// label like "admin email (X-User)" or "region or base url" is not itself a synonym, so posting
// values keyed by label makes the create route's own shape check report the field as missing even
// though the operator filled it in. Keying by `anyOf[0]` (a real synonym) guarantees the posted
// values satisfy the exact same check.
//
// Pure + framework-free on purpose: unit-testable without React, and reusable if another guided-entry
// surface needs the same values→canonical-keys step.
import type { FieldReq } from "./field-requirements";

// `valueByFieldKey` mirrors however the caller's input state is keyed (GuidedApiSetup keys its
// `values` state by `f.label` today) — this helper only needs to look up each field `f`'s entered
// value via that same key. Blank/whitespace-only entries are omitted (not sent as empty strings).
export function buildGuidedValues(
  fields: FieldReq[],
  valueByFieldKey: Record<string, string>,
  region?: string
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const f of fields) {
    const v = (valueByFieldKey[f.label] ?? "").trim();
    if (v !== "") values[f.anyOf[0]] = v;
  }
  // The region <select> (Proofpoint) owns its own field exclusively and is never one of `fields` (it's
  // `optional: true` in SECRET_FIELD_REQUIREMENTS) — the caller passes it separately. "Region" is
  // Proofpoint's region requirement's anyOf[0].
  if (region !== undefined) values["Region"] = region;
  return values;
}

// Spanning's guided setup derives two fields instead of collecting them (see api-setup-catalog's
// `derive: "spanning"` entry): the API base URL from the email-service + region selects, and the
// account id from the login email's domain WITHOUT its suffix (evan@acme.com → acme — Spanning's
// account-id convention, per /help/spanning). Keys are the canonical synonyms (anyOf[0]) of the
// "region or base url" and "account id" requirements, same contract as buildGuidedValues. The caller
// merges this OVER the typed values, so a derived key can't be shadowed by a stale text entry.
export function deriveSpanningValues(loginEmail: string, service: string, region: string): Record<string, string> {
  const values: Record<string, string> = {
    apiURL: `https://${service.trim().toLowerCase()}-api-${region.trim().toLowerCase()}.spanningbackup.com`,
  };
  const domain = (loginEmail.split("@")[1] ?? "").trim().toLowerCase();
  const account = domain.split(".")[0] ?? "";
  if (account) values["AccountID"] = account;
  return values;
}
