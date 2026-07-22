import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-license-dependency-selfheal",
  date: "2026-07-22",
  time: "17:00",
  title: "M365 onboard no longer fails on license service-plan dependencies — and shows a box to finish the assignment",
  items: [
    "M365 onboarding used to fail outright with Graph's \"License assignment failed because service plan X depends on the service plan(s) …\" — e.g. Microsoft Defender for Office 365 (Plan 2) needs an Exchange Online plan; Teams Phone needs Teams. It now assigns the whole configured license set in ONE call so interdependent plans enable together, and self-heals the rest",
    "When a service plan genuinely can't be enabled (its prerequisite lives in no license the user has — e.g. a standalone Defender add-on with no Exchange base), the runner now DISABLES just that one plan so the base license still lands (the account is licensed, mailbox provisions, downstream steps proceed) and records exactly what was held back and why. It's non-fatal, matching how a seat shortage is handled",
    "The parsing is generic — it reads Graph's own dependency list, so it covers every dependency (Defender→Exchange, Teams Phone→Teams, Teams Calling→Teams Phone, and any future one) with no hardcoded table",
    "New on the case run report: a \"Some licenses couldn't be fully assigned\" box on the M365 step lists each held-back plan, what it needs, and how to fix it, with a \"Retry license assignment\" button. Once you add the prerequisite (assign the base license or free a seat), retrying re-enables the plan — re-running is idempotent",
    "Runner 1.94.0 — needs deploy. Web changes render the recovery box from the runner's new LicenseDependencyIssues result field",
  ],
};
