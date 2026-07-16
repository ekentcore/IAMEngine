import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-force-sync-central-only",
  date: "2026-07-15",
  time: "17:15",
  title: "Force Spanning sync is now correctly a central-runner job — the run report stops showing it as waiting on a client's on-prem agent",
  items: [
    "A pending force Spanning sync showed 'waiting for <the client's on-prem agent> to claim it' — but that agent has no browser automation and can never run it. It always ran on the central runner; only the message named the wrong agent (the client agent polls more often, so it won the 'claims it next' pick). The pending line now names the central, browser-capable runner",
    "It also fixes a real stall: for a client whose cloud work is pinned to its own agent (run-cloud-on-own-agent), a force sync was pinned away from the central runner AND withheld from the client's browser-less agent — so nobody could claim it and it sat pending forever. Force sync is now always routed to the central runner, so it runs",
    "No change for the usual client — a force sync already ran on the central runner; this just makes the routing and the on-screen reason agree",
  ],
};
