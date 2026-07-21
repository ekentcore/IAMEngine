import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "audit-attributes-discovery-to-user",
  date: "2026-07-21",
  time: "17:30",
  title: "Audit names the person who kicked off an agent action, tagged “(Automation)”",
  items: [
    "When a user clicked something the runner/background job then executed — Refresh AD objects / cloud groups, Test connections, M365/Google auto-setup — the audit log recorded the doer as “agent:<id>” or “system”, so it looked like the machine acted on its own",
    "Those result rows now carry the user who kicked them off (stamped at request/start time) and render as “Name (Automation)” — distinct from a plain “Name” for a direct edit, so you can tell “they clicked, the runner did it” from “they changed it themselves”",
    "Covers AD-object and cloud-group/mailbox discovery, connection-test results, and per-client M365/Google setup outcomes; the agent id stays in the row detail for traceability",
    "Direct actions (create / archive / edit a client) already named the user — this closes the runner-result gap",
  ],
};
