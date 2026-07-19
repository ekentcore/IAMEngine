import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-auto-setup-orchestration-core",
  date: "2026-07-19",
  time: "17:45",
  title: "Automated M365 setup: per-client orchestration core (Phase 4 groundwork)",
  items: [
    "New internal `setupM365ForClient` chains the pieces built so far into one per-client run: check for a Global-Admin secret, get a device code, dispatch the browser sign-in job, poll for the delegated Graph token, provision the app registration, then write the credential back to Delinea.",
    "The runner always reports the browser sign-in job as 'ok' even when the actual sign-in failed (MFA push/SMS, bad creds) — the real failure is a WARN line buried in the job's result. When the token poll fails, this core pulls those WARN lines out and surfaces them so a failure says why, not just that it happened.",
    "Every network/db collaborator is injected (dependency-injected), so the whole chain — including the WARN-surfacing logic — is unit-tested with no real Entra, Delinea, or database involved. Never logs or returns a token, client secret, or certificate value.",
    "Not wired to a runnable dispatch, a progress table, or a UI yet — this is the testable core only. The run-wrapper (detached sweep + progress tracking), the real job-dispatch, and the button are specced in docs/superpowers/specs/2026-07-19-m365-auto-setup-phase4-5-design.md as a live-validated follow-up (needs a real tenant + TOTP Global Admin + a live browser to validate).",
  ],
};
