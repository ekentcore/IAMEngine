// Pure matching logic for the Delinea credential-recovery sweep: parse `\Clients\<name> !CORE###!`
// folder names, and classify a folder's secret NAMES (plus template/subfolder hints — never values)
// onto the logical secret slots the app's systems reference (lib/modules/catalog.ts vocabulary,
// e.g. "m365-admin", "mimecast", "spanning").
//
// Confidence tiers drive both auto-picking and the recovery report:
//   high    — the platform's own naming ("IAM Engine", "Mimecast API", template "Automation - Api")
//   medium  — a system token + an API/automation qualifier, or a recognizable admin-account pattern
// Anything weaker is left for the LLM pass (which can only choose among these records) or a human.

import type { SecretSearchRecord } from "./delinea-search";

export type ParsedClientFolder = { coreId: string; displayName: string };

// "ACORE Capital, LP !CORE507!" -> { coreId: "CORE507", displayName: "ACORE Capital, LP" }
export function parseClientFolderName(folderName: string): ParsedClientFolder | null {
  const m = folderName.match(/^(.*?)\s*!\s*(core\s*\d+)\s*!\s*$/i);
  if (!m) return null;
  return { displayName: m[1].trim(), coreId: m[2].replace(/\s+/g, "").toUpperCase() };
}

// Normalize a client name for fallback (no CORE id) matching: case/punctuation/legal-suffix-blind.
export function normalizeClientName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'’&()!]/g, " ")
    .replace(/\b(llc|llp|lp|inc|ltd|co|corp|corporation|company|group|partners|management|holdings)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type Tier = "high" | "medium";
export type Candidate = {
  slot: string; // logical Secret.name (or a suggested one for extras, e.g. "sentinelone")
  tier: Tier;
  stale: boolean; // named like a retired/foreign credential — never auto-picked
  ambiguous: boolean; // the name mentions several systems (combo secrets) — demoted, never high
  reason: string;
  record: SecretSearchRecord;
};

// Names that are clearly NOT an integration credential regardless of which system they mention:
// mail-flow accounts, wifi/printers/room hardware, LDAP/SFTP/sync connectors, per-person logins,
// analytics add-ons. These are the false positives a bare system-token scan produces — e.g.
// "Zoom Room - iPad Passcode" (zoom), "Egnyte Morgan Stanley SFTP password" (egnyte),
// "MimecastLdap Service account" (ad-dc). Matching one of these disqualifies the record entirely.
const NOT_A_CRED =
  // NOTE: `ldap` has no leading \b — it shows up glued to a system name ("MimecastLdap"), and any
  // name containing it is a directory-sync connector, not an integration credential.
  // "backup codes"/"recovery codes"/"MFA" are the break-glass codes for an account, NOT the API
  // credential — "S1 API backup codes" is not a SentinelOne integration secret.
  /ldap|backup codes?|recovery codes?|\b(mfa|2fa|totp|smtp|scan[ -]?to[ -]?email|scan|alerts? subscriber|password expiration|wifi|wi-fi|ssid|printer|conference|kiosk|welcome|distribution list|room|ipad|passcode|sftp|ftp|dmarc|non-sso|nonsso|shared mailbox|mailbox|jamf|maas360|papercut|autopilot|auto-pilot)\b/i;

// Retired / previous-MSP / test credentials: kept visible as candidates for the report and the LLM,
// but never auto-picked while a non-stale candidate exists (and never picked at all by heuristics).
const STALE = /\b(inactive|do not use|old|legacy|prior msp|decommission(ed)?|disabled|deprecated|test|itg|expired|broken|revoked)\b|\(itg\)/i;

// A qualifier that marks a name as an automation/API credential rather than a human account.
const API_QUALIFIER = /\b(api|automation|integration|svc|service account|iam)\b/i;

// Wording that marks a Spanning secret as the CONSOLE sign-in (an M365 admin login driven in a
// browser) rather than the API credential — the two are not interchangeable. See the token scan.
const SPANNING_PORTAL = /\b(portal|console|browser|sso|sign[- ]?in|log[- ]?in|login)\b/i;

// System token -> logical slot. Order matters only for reporting; every matching token is returned
// and multi-token names are flagged ambiguous.
const SYSTEM_TOKENS: Array<{ slot: string; token: RegExp }> = [
  { slot: "mimecast", token: /mimecast/i },
  { slot: "spanning", token: /spanning/i },
  { slot: "perimeter81", token: /perimeter\s*81|\bp81\b/i },
  // "S1_API" has no \b after the 1 (underscore is a word char), so allow _- as terminators too.
  { slot: "sentinelone", token: /\bsentinel(\s*one)?\b|\bs1(\b|[_-])/i },
  { slot: "adobe", token: /adobe/i },
  { slot: "egnyte", token: /egnyte/i },
  { slot: "zoom", token: /zoom/i },
  // "workspace" alone is NOT a google signal — "Slack Workspace Admin" is a Slack credential.
  { slot: "google-admin", token: /google|g\s*suite|gsuite/i },
  { slot: "slack", token: /slack/i },
  { slot: "knowbe4", token: /know\s*be\s*4|knowbe4|\bkb4\b/i },
  { slot: "teams-admin", token: /\bteams\b/i },
  { slot: "dropbox", token: /dropbox/i },
  { slot: "1password", token: /1password|one\s*password|\b1pw\b/i },
  { slot: "proofpoint", token: /proofpoint/i },
  { slot: "duo", token: /\bduo\b/i },
  { slot: "xmatters", token: /xmatters/i },
  { slot: "salesforce", token: /salesforce/i },
  { slot: "hubspot", token: /hubspot/i },
  { slot: "jira", token: /\bjira\b/i },
  { slot: "logicmonitor", token: /logicmonitor|logic\s*monitor/i },
];

// M365/Entra admin-credential shapes. The platform's own secrets ("IAM Engine", template
// "Entra Azure AD Account"/"Automation - Azure App", "CoreAutomation - Azure ...") are high; a
// "<domain> - Office 365 GA - Coretelligent" Global Admin account is medium (usable, but a human
// account rather than the onboarding app).
const M365_HIGH = /^iam\s*engine$/i;
// The Azure/Entra qualifier must be a WORD, not a substring: an unanchored `auth` alternative also
// matched "CoreAutomation - Duo Authentication" / "... OAuth key" and filed another product's
// credential under m365-admin at HIGH confidence.
const M365_HIGH_COREAUTO = /^(legacy\s*-\s*)?core\s*automation\b(?=.*\b(azure|entra|o365|m365|365)\b)|^core\s*automation$/i;
const M365_MEDIUM =
  /\b(o365|office\s*365|m365|azure\s*ad|entra)\b.*\b(ga|global admin|admin)\b|\b(ga|global admin)\b.*\b(o365|office\s*365|m365)\b|^iam\s*engineer$/i;


// On-prem AD automation account. Deliberately NARROW: it must name the automation/IAM/onboarding
// purpose. A generic "<something> Service Account" is NOT enough — the vault is full of per-vendor
// service accounts (scan, LDAP sync, MDM) that would be catastrophic to hand the AD executor, which
// creates and disables users. Anything weaker is left to a human (see AUTOFILL_SLOTS).
const AD_DC_MEDIUM = /\b(iam|onboard(ing)?|automation|script ?runner|user ?provision(ing)?)\b.*\b(svc|service|account|ad|active directory)\b|\b(svc|service)[-_ ]?(iam|automation|onboard(ing)?|scriptrunner)\b/i;

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

// Classify one secret record onto zero or more slot candidates.
export function classifySecret(rec: SecretSearchRecord): Candidate[] {
  const name = norm(rec.name);
  if (!name || NOT_A_CRED.test(name)) return [];
  const stale = STALE.test(name);
  const tmpl = rec.secretTemplateName ?? "";
  const out: Candidate[] = [];

  // Platform-native m365-admin shapes first (exact names/templates beat token scanning).
  if (M365_HIGH.test(name)) {
    out.push({ slot: "m365-admin", tier: "high", stale, ambiguous: false, reason: `name "${name}" is the platform's IAM Engine credential`, record: rec });
  } else if (tmpl === "Automation - Azure App" || M365_HIGH_COREAUTO.test(name)) {
    out.push({ slot: "m365-admin", tier: "high", stale, ambiguous: false, reason: tmpl === "Automation - Azure App" ? `template "${tmpl}"` : `CoreAutomation Azure naming`, record: rec });
  } else if (tmpl === "Entra Azure AD Account" && /\biam\b/i.test(name)) {
    out.push({ slot: "m365-admin", tier: "high", stale, ambiguous: false, reason: `template "${tmpl}" + IAM naming`, record: rec });
  }

  // Token scan across all systems.
  const tokenHits: Array<{ slot: string }> = [];
  const seen = new Set<string>();
  for (const { slot, token } of SYSTEM_TOKENS) {
    if (seen.has(slot)) continue;
    if (token.test(name)) {
      // Spanning has TWO different credentials and they are NOT interchangeable: the API clientId/
      // secret (licensing) and an M365 admin sign-in for the browser console (force-sync). A name like
      // "Spanning Portal Login" would otherwise be autofilled into the API slot, where the runner would
      // send that admin's EMAIL + PASSWORD to Spanning as clientId:clientSecret — every licensing call
      // 401s, and a human would be hunting a "rotated" API key that never moved.
      //
      // But an API QUALIFIER wins over portal wording: "Spanning API Login" / "Spanning Integration
      // Sign-in" are ordinary names for the API credential, and re-routing those would strand the API
      // slot with no candidate at all AND autofill API material into the portal slot — both directions
      // of the same mistake. Only unqualified portal wording re-routes.
      const resolved = slot === "spanning" && SPANNING_PORTAL.test(name) && !API_QUALIFIER.test(name) ? "spanning-portal" : slot;
      if (seen.has(resolved)) continue;
      seen.add(slot);
      seen.add(resolved);
      tokenHits.push({ slot: resolved });
    }
  }
  // Ambiguity means TWO SPECIFIC PRODUCTS in one name ("Adobe / Zoom admin") — a real shared login
  // we shouldn't auto-assign. A generic "365"/"Azure"/"O365" mention does NOT count: SaaS credentials
  // are routinely named for the tenant they administer or back up ("Spanning O365" is the Spanning
  // credential, not an M365 one), and counting it stranded those slots as unresolvable.
  const ambiguous = tokenHits.length >= 2;

  for (const { slot } of tokenHits) {
    const qualified = API_QUALIFIER.test(name) || tmpl === "Automation - Api";
    const tier: Tier = qualified && !ambiguous ? "high" : "medium";
    out.push({
      slot,
      tier,
      stale,
      ambiguous,
      reason: qualified ? `"${name}" mentions ${slot} with an API/automation qualifier${tmpl ? ` (template "${tmpl}")` : ""}` : `"${name}" mentions ${slot}`,
      record: rec,
    });
  }

  // Human M365 admin accounts (only when nothing better matched above).
  if (out.every((c) => c.slot !== "m365-admin") && M365_MEDIUM.test(name)) {
    out.push({ slot: "m365-admin", tier: "medium", stale, ambiguous, reason: `"${name}" looks like an M365 admin account`, record: rec });
  }

  // On-prem AD service accounts.
  if (AD_DC_MEDIUM.test(name) || (tmpl === "Active Directory Account" && API_QUALIFIER.test(name))) {
    out.push({ slot: "ad-dc", tier: "medium", stale, ambiguous, reason: `"${name}" looks like an AD service account${tmpl ? ` (template "${tmpl}")` : ""}`, record: rec });
  }

  return out;
}

// Rank a slot's candidates: live before stale, high before medium, unambiguous first, the
// platform's Identity Services subfolder first, automation templates first, then shortest name
// (decorated names like "(USE THIS)" rank behind the plain one).
export function rankCandidates(cands: Candidate[]): Candidate[] {
  const score = (c: Candidate): number => {
    let s = 0;
    if (!c.stale) s += 1000;
    if (c.tier === "high") s += 500;
    if (!c.ambiguous) s += 250;
    if (/\\identity services($|\\)/i.test(c.record.folderPath)) s += 100;
    const tmpl = c.record.secretTemplateName ?? "";
    if (tmpl === "Automation - Api" || tmpl === "Automation - Azure App" || tmpl === "Entra Azure AD Account") s += 50;
    s -= Math.min(c.record.name.length, 49) / 50; // gentle tiebreak toward the undecorated name
    return s;
  };
  return [...cands].sort((a, b) => score(b) - score(a));
}

// --- Write policy -------------------------------------------------------------------------------
// Which picks are safe to WRITE unattended, vs. only to SUGGEST in the report for a human.
//
// A wrong credential that resolves cleanly is worse than an empty slot: the app shows it green and
// it fails at run time. So a medium-confidence pick is only auto-filled for cloud SaaS systems,
// where a wrong credential fails closed at the provider's auth endpoint and the connection test
// turns red — visible and harmless.
//
// `ad-dc` is deliberately EXCLUDED: the AD executor creates and disables real users on-prem, and a
// medium-confidence name match there is a guess with a blast radius. High-confidence AD picks still
// auto-fill; anything softer is reported for a human to confirm.
export const AUTOFILL_MEDIUM_SLOTS = new Set([
  "m365-admin", "mimecast", "spanning", "adobe", "egnyte", "zoom", "google-admin",
  "slack", "dropbox", "1password", "knowbe4", "proofpoint", "perimeter81", "sentinelone",
  "teams-admin", "xmatters", "duo", "salesforce", "hubspot", "jira", "logicmonitor",
]);

// Should this pick be persisted, or only suggested?
//   accessOk  — the app RESOLVED the secret from Delinea (it exists and we can read it).
//   fieldsOk  — its field shape is usable by the runner (the bar the in-app Test applies). `null`
//               means we could not determine it (the value read failed) — never treat that as pass.
//
// An id the app cannot even read is NEVER written, at any confidence: that would replace an honest
// "not set" with a broken reference. A high-confidence pick that resolves but whose FIELDS are
// incomplete is still written (it is demonstrably the right credential — e.g. the platform's own
// CoreAutomation app — and the report flags the field fix), but a medium-confidence one is not.
export function shouldAutofill(c: Candidate, accessOk: boolean, fieldsOk: boolean | null): boolean {
  if (c.stale) return false; // a retired/prior-MSP credential is never written unattended
  if (c.ambiguous) return false; // a shared two-product login is never auto-assigned
  if (!accessOk) return false;
  if (c.tier === "high") return true;
  return fieldsOk === true && AUTOFILL_MEDIUM_SLOTS.has(c.slot);
}

// Classify every record in a client's folder and group ranked candidates per slot.
export function candidatesBySlot(records: SecretSearchRecord[]): Map<string, Candidate[]> {
  const by = new Map<string, Candidate[]>();
  for (const rec of records) {
    for (const c of classifySecret(rec)) {
      if (!by.has(c.slot)) by.set(c.slot, []);
      by.get(c.slot)!.push(c);
    }
  }
  for (const [slot, cands] of by) by.set(slot, rankCandidates(cands));
  return by;
}
