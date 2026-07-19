import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-devicecode-auth",
  date: "2026-07-19",
  time: "16:45",
  title: "Groundwork: device-code Global-Admin auth for automated M365 setup (runner 1.76.0)",
  items: [
    "Internal plumbing to obtain a Microsoft Graph token carrying a client's Global-Admin privileges via the OAuth device-code flow - the auth half of the upcoming one-click M365 app-registration setup",
    "A new browser flow signs the Global Admin in at microsoft.com/devicelogin, with MFA codes minted from Delinea at the prompt (TOTP only; push/SMS accounts are skipped) - reusing the same hardened Microsoft sign-in machinery as the Spanning sync",
    "Not yet wired end-to-end (a later phase connects it to per-client setup); the browser step needs live validation before production use",
  ],
};
