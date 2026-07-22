import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-setup-m365",
  date: "2026-07-22",
  time: "14:00",
  title: "New tool: Fleet setup — M365 — test and fix every client's M365 credential from one page",
  items: [
    "Tools → 'Fleet setup — M365' lists every client that has an m365, entra, or exchange system in one table and runs the connection test across all of them automatically when the page opens (rejoining a sweep already in progress on reload)",
    "Each row shows that client's M365 app-registration health with an expandable per-operation rights breakdown — the same missing-permission and 'extra access' detail as a single client's Test connections panel",
    "Filter the fleet by state — Missing permissions, Missing credentials, Over-permissioned, Connection failed, Completed, or Untested (each chip carries a live count) — plus a name / CORE-id / system search, so you can work through exactly the clients that need attention",
    "'Correct permissions' on a client that's missing permissions opens the automated setup, keeping the existing API secret and pre-checking exactly the missing optional permissions — it reconciles and admin-consents the gaps without rotating the credential",
    "'Set up M365' on a client with no working credential runs the full automated setup, asking for the Global-Admin Delinea number with suggestions",
    "The automated M365 setup modal no longer jumps straight to the success screen for an already-configured client — it now always opens on the form (with an 'already configured' banner and the last run one click away), so you can work through it and adjust permissions any time",
  ],
};
