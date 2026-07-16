import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "chat-alerts-warnings-and-master-switch",
  date: "2026-07-14",
  time: "14:15",
  title: "Errors and warnings now actually reach the chat room (and warnings can reach it at all)",
  items: [
    "The master switch on Settings was off, so every error and warning was silently dropped - while the per-destination Test button still delivered, because Test deliberately bypasses the switch. A channel could test green and look completely healthy while nothing real ever sent. Settings now warns, in the page, when destinations are configured but the switch is off, and a successful Test says so instead of just reporting 'delivered'",
    "Warnings could never reach a chat room at all - there was no warning event to send. A warning is a step that SUCCEEDED but whose validation read-back did not confirm the change (the amber lines on /runs), which is exactly the kind of quiet half-failure worth knowing about. There is now a 'Step warning' event, on by default and toggleable like the rest, and it carries the same warning lines the run report shows",
    "A failed single-step re-run sent nothing. Re-running one broken step is the normal way an operator retries, so its failure going silent was the worst case. Step-level alerts (failed and warning) now fire for single-step re-runs too; case-level alerts still only fire off a full run, where a case status actually means something",
    "Webhook URLs and Zoom tokens are now trimmed. The saved restricted-room Zoom token had a leading space, which Zoom would reject as a bad Authorization header - a room that was configured but could never have received anything",
    "Per-client overrides ('also send to this client's own room' / 'send there instead') were correct all along, but were gated behind the same three gaps - so they now work for warnings and single-step re-runs too. Verified end to end: 'also' hits both rooms, 'instead' hits only the client's, and a restricted client's override never leaks to the all-clients room",
  ],
};
