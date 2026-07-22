import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-browser-api-setup",
  date: "2026-07-22",
  time: "07:15",
  title: "Spanning: automatic (browser) API-token setup",
  items: [
    "Spanning now has an \"Automatic (browser)\" setup like Mimecast: the runner signs into the Spanning admin console (Microsoft-365 SSO, reusing the shared MS-SSO login), opens Settings → API Token, generates the key if there isn't one (never Regenerate — that invalidates the current key), and harvests it",
    "The harvested token is vaulted as the client's `spanning` credential in the Vendor Delinea subfolder, wired onto the client, and recorded in the module-setup provenance — then scrubbed from the job result so the raw key never lingers",
    "Only shows for clients that have the Spanning system; signs in with the client's `spanning-portal` console login (a per-run Delinea id also works). Runner 1.85.0 — needs deploy",
    "NEEDS LIVE SELECTOR VALIDATION — the post-login Settings → API Token navigation + harvest selectors are best-effort against an unreachable console; the M365-SSO sign-in reuses the live-verified force-sync path",
  ],
};
