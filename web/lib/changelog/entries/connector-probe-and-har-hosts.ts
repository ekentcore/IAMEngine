import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "connector-probe-and-har-hosts",
  date: "2026-07-17",
  time: "13:45",
  title: "Connector HAR import can probe the captured API with a real credential; browser connectors seed their host allowlist from a HAR",
  items: [
    "The HAR import wizard gained a credential probe: pick a client with a wired secret (or enter a Delinea secret number) and it replays the capture's GET/HEAD calls with that credential applied exactly the way the runner would apply it (bearer/basic/header/oauth2) - so you learn before publishing whether a portal's private API accepts a stored credential, or rejects everything (session-cookie auth, meaning the browser lane is the right build)",
    "Writes are never replayed - the HAR was recorded doing a real task, so its POST/DELETE calls did something once already; the probe drops them server-side and names what it skipped",
    "Secret values never reach the browser and response bodies are never read - the probe's whole product is the status code per endpoint plus a verdict sentence; every probe writes an audit row (hosts, statuses, verdict - never a header or a value)",
    "The probe refuses to be pointed inward: literal IPs, local/internal names, and public names that resolve into private address space are all rejected before anything is sent",
    "Browser connector editors can now seed their hosts allowlist from a HAR capture (every host the portal touched, ticked in) - and if the capture carries API-looking calls, the panel says so and suggests trying an http connector with the probe instead",
  ],
};
