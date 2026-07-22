import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "guided-setup-live-test-feedback",
  date: "2026-07-22",
  time: "14:15",
  title: "Guided credential setup now shows the same live test feedback as the client's Test connections button",
  items: [
    "The live tests in guided setup used to give almost no feedback - a single 'X of Y verified' counter and a muted per-step verdict, so during a run you couldn't see what was being tested, what passed, or what failed",
    "Each setup step now shows the same staged badges the client page's Test connections panel does - Fields, Can access, API works, and an expandable per-operation Rights table - updating live as the runner works",
    "Every step gets its own 'Test this connection' button that queues a real read for just that credential; the client-wide 'Run live connection tests' button stays for testing everything at once",
    "The Automatic (browser) setup run's checklist now advances step-by-step as it goes (signing in -> creating the app -> harvesting -> vaulting) instead of sitting on an indeterminate 'working...' - the runner reports each stage live (runner 1.89.0)",
  ],
};
