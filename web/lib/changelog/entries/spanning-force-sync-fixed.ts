import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-force-sync-fixed",
  date: "2026-07-15",
  time: "16:15",
  title: "Force Spanning sync works again, and no longer piles a new warning step onto the case each time",
  items: [
    "Force Spanning sync had stopped working across every client: the Central Cloud Runner (the only agent that runs browser automation) had a half-installed Playwright, so the browser flow crashed the instant it started and reported the useless 'produced no result (Node.js v24.14.0)'. Brock Built's UM0029776 is where this surfaced",
    "Fixed the runner directly (reinstalled Playwright), so force sync runs to completion now. To stop it recurring: the agent no longer advertises 'browser' when Playwright is only half-installed, and self-heals on the next restart instead of claiming jobs it can't run",
    "The browser flow now reports the real reason it couldn't run (e.g. 'Playwright is not installed - run npm install') instead of a bare crash banner, so a future break is diagnosable at a glance",
    "Triggering a force sync used to append a brand-new 'spanning-force-sync' step every time - UM0029776 had two. It now re-uses a single step per case (re-running it in place), shown once",
    "That step now reads 'Spanning force sync' and is nested under the Spanning step as a sub-action, instead of a bare 'spanning-force-sync' line sitting at the top level",
    "Agents pick up the self-heal on runner 1.63.0",
  ],
};
