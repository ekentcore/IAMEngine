import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "single-step-claimed-first",
  date: "2026-08-28",
  time: "11:00",
  title: "\"Run this step only\" goes to the front of the queue, and tells you it is waiting",
  items: [
    "Clicking \"Run this step only\" paused the case and then appeared to do nothing. It was doing something — it just took a median of 11 minutes to start, and 23 minutes on the case that reported it, by which point nobody was still watching. (FR #0000101)",
    "An operator-initiated step is now claimed BEFORE any background work. Everything else keeps its existing order, so a case's own steps still run in sequence",
    "Why it was slow: a runner doesn't look for new work while it is busy — it finishes what it claimed first — and the queue gave a human waiting at the screen no priority over routine work",
    "The step also now says so on the case: \"queued to run on its own — waiting for a runner to pick it up\", instead of a paused case with a silent step that looks stalled",
    "The button itself was never broken: 67 of the 76 times it has been used, the step ran. It just ran long after the operator gave up on it",
    "Web-only — no runner change",
  ],
};
