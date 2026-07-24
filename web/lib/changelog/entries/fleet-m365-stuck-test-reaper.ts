import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-m365-stuck-test-reaper",
  date: "2026-07-24",
  time: "13:15",
  title: "Fleet Setup — M365: stuck 'testing…' clients now self-heal, and the Rights column reads 'Passed'",
  items: [
    "A client could get pinned on 'testing…' forever: a hybrid client's on-prem Exchange (or AD) connection test is queued for the client's own agent, and if no agent ever claims it — or an agent claims it then dies before reporting — the row sat pending/running with nothing to settle it (unlike jobs, connection tests had no lease reclaim). Neither Stop nor Retest could clear it, so the 'Correct/Set up permissions' button stayed disabled behind 'Testing…'",
    "The fleet roll-up now reaps M365-family connection tests that have sat pending/running past the 10-minute staleness window: a never-claimed or never-reported test is cleared on the next page load, and the client is classified from the tests that DID run (e.g. a client whose m365 + entra passed now shows healthy instead of hanging on the un-run Exchange test)",
    "The Rights column now shows '✓ Passed' in green for a client whose permissions verify, instead of the lowercase 'ok'",
    "Web-only, no runner change — the reaper only clears the app's own stale test rows; it never marks a client failed for an un-run on-prem test",
  ],
};
