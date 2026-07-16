import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "import-clients-by-coreid",
  date: "2026-07-13",
  time: "16:30",
  title: "Add client: import by CORE id, built out from the KBs automatically",
  items: [
    "Paste one CORE id or a list of them into Add client - each is looked up in ServiceNow, created, and built out from its onboarding and offboarding KB articles (runbook sections plus the systems they imply) without anyone hunting for KB numbers",
    "It also fills in clients you already have: a client the roster sync created as a bare row (no runbook, no systems, cases that plan no steps) gets built out, while any runbook that already exists is left strictly alone - a re-import never overwrites what you have edited",
    "Results stream in one client at a time: a single import drops you on that client's page, a batch leaves a summary table showing what was built, what already existed, and what could not be found",
    "A KB that does not look like a real runbook guide (a request form, say) is NOT imported - it is named on the row for you to review, rather than quietly becoming client config that a live case would run against",
  ],
};
