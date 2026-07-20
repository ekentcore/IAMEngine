import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-signin-callout",
  date: "2026-07-20",
  time: "16:15",
  title: "M365 setup: a prominent 'approve the sign-in' callout, and the Exchange admin outcome on the result",
  items: [
    "The sign-in step blocks on a human approving the Global Admin sign-in (MFA), so a spinning tracker looked wedged with no hint of what to do. It now shows a prominent 'Action needed — approve the Global Admin sign-in' callout with the device code in large type, an Open devicelogin button, and an escalation note once it's been waiting a while — so it's obvious the runner is waiting on you, not stuck.",
    "The success screen now shows the Exchange Online admin outcome on its own line: ✓ granted (Exchange.ManageAsApp + Exchange Administrator role) when it worked, or ⚠ with the exact reason when a piece couldn't be granted (e.g. the Global Admin lacks the rights to add the app to the Exchange Administrator role) — so 'did it actually do the Exchange part?' has an answer instead of being buried in the run log.",
    "No backend change to the run itself — the Exchange grant already runs on every provision (incl. re-runs); this surfaces whether it landed. Next: add/remove optional permissions on an already-provisioned app.",
  ],
};
