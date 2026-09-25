// Per-case Google Workspace OU (FR #81). The Google executor already reads the target OU from its job
// config — `ou` on onboard (default "/Active Users") and `inactiveOu` on offboard (default
// "/Email & Calendar/Inactive"), set per client under the system's config.onboard / config.offboard.
// An operator can pick a different OU for ONE case; it's stored in the payload as googleOu /
// googleInactiveOu through the case fields route, which marks it operator-sourced so a ServiceNow
// re-pull keeps it.
import type { PlannedJob } from "../orchestrator";

export const GOOGLE_OU_FIELD = { onboard: "googleOu", offboard: "googleInactiveOu" } as const;
const CONFIG_KEY = { onboard: "ou", offboard: "inactiveOu" } as const;

// A Google OU path: absolute, not the root (the executor refuses to place a user there), no empty
// segments. Returns the cleaned path or an error message for the operator.
export function checkGoogleOu(raw: string): { ok: true; ou: string } | { ok: false; error: string } {
  const ou = raw.trim().replace(/\/+$/, "");
  if (!ou) return { ok: false, error: "enter an OU path, e.g. /Active Users" };
  if (!ou.startsWith("/")) return { ok: false, error: "a Google OU path starts with / — e.g. /Active Users/Sales" };
  if (ou === "" || ou === "/") return { ok: false, error: "the root OU (/) isn't allowed — pick a sub-OU" };
  if (ou.split("/").slice(1).some((s) => s.trim() === "")) return { ok: false, error: "the OU path has an empty segment (//)" };
  return { ok: true, ou };
}

export function withGoogleOu(jobs: PlannedJob[], payload: Record<string, unknown>, action: string): PlannedJob[] {
  if (action !== "onboard" && action !== "offboard") return jobs;
  const raw = payload[GOOGLE_OU_FIELD[action]];
  if (typeof raw !== "string" || !raw.trim()) return jobs;
  const checked = checkGoogleOu(raw);
  if (!checked.ok) return jobs; // an invalid stored value never overrides the client's setting
  return jobs.map((j) =>
    j.systemKey === "google-workspace"
      ? { ...j, config: { ...((j.config as Record<string, unknown> | null) ?? {}), [CONFIG_KEY[action]]: checked.ou } }
      : j
  );
}
