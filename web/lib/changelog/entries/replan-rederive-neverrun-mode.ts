import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "replan-rederive-neverrun-mode",
  date: "2026-07-22",
  time: "15:15",
  title: "Re-planning now picks up a system's mode correction on a never-run step",
  items: [
    "When you correct a system's execution mode on the client page (e.g. Adobe from SCIM to API because it's really an API integration, not IdP-provisioned) and then re-plan an existing case, the corrected step now dispatches",
    "The bug: a SCIM step is born \"succeeded\" without ever dispatching, so an incremental re-plan kept it (it's a \"succeeded\" job) but never rewrote its mode. The step stayed a phantom \"verified\" with no actions — re-running it just re-affirmed the no-op. The mode fix never reached the planned case",
    "Re-plan now detects that exact shape — a step that is \"succeeded\" but never actually started (startedAt is null) whose planned mode has since changed — and re-derives it to the new mode and that mode's born status (API → pending so it dispatches, SCIM → succeeded, otherwise manual)",
    "A genuinely-executed step always has startedAt set, so this can never clobber real work: a step that actually ran is left untouched, and a SCIM step that stays SCIM is not disturbed",
    "Web-only — no runner change",
  ],
};
