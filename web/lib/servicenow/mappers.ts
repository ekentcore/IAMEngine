// Pure normalization: raw SnAccount -> NormalizedSnClient. No I/O, no Prisma, no env.
// This is the layer to unit-test and the layer to touch if ServiceNow's shape changes.
import type { SnAccount } from "./types";

export type NormalizedSnClient = {
  serviceNowSysId: string;
  coreId: string | null;
  name: string;
  primaryDomain: string; // bare domain derived from `website`, or "" if absent
  region: string | null;
  timezone: string | null;
  supportStatus: string | null;
  coManaged: boolean;
  onboardingRating: number | null; // 1|2|3, null if the choice is text
  offboardingRating: number | null;
  // sys_id of the SN parent account (account hierarchy), or null. Resolved to Client.parentId in a
  // second sync pass (the parent row may not exist yet during the batch).
  parentSysId: string | null;
  // Raw choice labels kept for parked-lane badges (e.g. "Document Missing", "Needs Cleanup").
  metadata: { onboardingLabel: string | null; offboardingLabel: string | null };
};

// Strip protocol, leading "www.", and any path/query from a website into a bare domain.
export function normalizeDomain(website: string | undefined | null): string {
  if (!website) return "";
  let d = website.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split(/[/?#]/)[0]; // drop path / query / fragment
  return d.trim();
}

// A rating is the integer 1, 2, or 3; anything else (e.g. "Document Missing") -> null.
export function parseRating(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : null;
}

function blankToNull(s: string | undefined | null): string | null {
  const v = (s ?? "").trim();
  return v === "" ? null : v;
}

export function normalizeAccount(raw: SnAccount): NormalizedSnClient {
  const onValue = raw.u_onboarding?.value;
  const offValue = raw.u_offboarding?.value;
  return {
    // Empty when sys_id is missing/malformed; the sync service treats "" as a skip-with-error
    // rather than letting the whole batch throw.
    serviceNowSysId: raw.sys_id?.value ?? "",
    coreId: blankToNull(raw.u_core_id?.value),
    name: raw.name?.display_value || raw.name?.value || "(unnamed)",
    primaryDomain: normalizeDomain(raw.website?.value),
    region: blankToNull(raw.u_region?.display_value || raw.u_region?.value),
    timezone: blankToNull(raw.u_time_zone?.display_value || raw.u_time_zone?.value),
    supportStatus: blankToNull(raw.u_support_status?.display_value || raw.u_support_status?.value),
    coManaged: (raw.u_comanaged_it?.value ?? "false") === "true",
    onboardingRating: parseRating(onValue),
    offboardingRating: parseRating(offValue),
    parentSysId: blankToNull(raw.parent?.value),
    metadata: {
      // keep the human label only when it isn't just the numeric rating
      onboardingLabel: parseRating(onValue) === null ? blankToNull(raw.u_onboarding?.display_value) : null,
      offboardingLabel: parseRating(offValue) === null ? blankToNull(raw.u_offboarding?.display_value) : null,
    },
  };
}
