import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-force-sync-works",
  date: "2026-07-13",
  time: "23:00",
  title: "Spanning force-sync actually works now (runner 1.50.0)",
  items: [
    "The sync had never once completed - every attempt died at the Microsoft 'Stay signed in?' prompt, which left the browser parked on Microsoft's page so a perfectly good sign-in was reported as a failure. It is now answered",
    "The flow is driven end-to-end by a real test for the first time (against a stand-in Microsoft SSO portal on a separate origin): sign-in, minted MFA code, 'Stay signed in?', redirect, and the sync call itself",
    "It no longer tries to sign in with the Spanning API key - that can never authenticate against Microsoft and repeated attempts are how an account gets locked out. It now asks for a real portal login instead, and says so without ever echoing the value",
    "Still needed from you: put an M365 admin's email + password on the Spanning Delinea secret (PortalUsername/PortalPassword) and enable One-Time Password on it for the MFA prompt",
  ],
};
