// The build change log shown on /changelog (global admins and above) and shareable to the
// configured chat channels. APPEND A NEW ENTRY (at the TOP) whenever a feature/fix ships —
// the page renders this file directly, so the log updates with the deploy that ships the work.
// Bullets are sent to chat verbatim as plain text: keep them one line each, no markdown.
export type ChangelogEntry = {
  id: string; // stable slug — the send API references entries by id
  date: string; // ISO date (YYYY-MM-DD) the work shipped; append "~" nowhere — use `approx` instead
  approx?: boolean; // true when the date is a best-effort reconstruction
  title: string;
  items: string[];
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "engine-opt-out-hardening",
    date: "2026-07-13",
    title: "Hardening: 'do not use engine' + parent inheritance (PR #41)",
    items: [
      "A 'do not use engine' client's trashed cases now STAY trashed - previously every intake sweep un-trashed them because the check ran after the restore",
      "The New case form now refuses an opted-out client too; the flag is enforced once at the case-creation layer, so no path can bypass it",
      "Breaking a child's parent link with 'Keep a copy' no longer merges the parent's systems onto a child that already has its own",
      "Breaking the link now always records, even when there's nothing to copy (the badge could get stuck on 'inherits')",
      "A child that brokers its parent's credentials no longer shows a false 'not set up' badge - readiness now mirrors what dispatch actually resolves",
      "The client page no longer claims 'inherits the parent's runbook' after the link is broken; clearing 'no engine' from the clients list now asks first",
    ],
  },
  {
    id: "exchange-manager-name",
    date: "2026-07-13",
    title: "Offboard: Exchange now uses the manager the intake form names (runner 1.48.0)",
    items: [
      "The offboard form carries the manager as a NAME (\"managerName\"), which the Exchange step never read - it only understood email addresses, so it skipped the Full Access delegate even when the case named the manager",
      "Exchange now resolves that name to a mailbox (Exchange Online first, then on-prem AD) and grants them Full Access to the shared mailbox",
      "A name matching several mailboxes is never guessed at - the step warns and skips instead",
    ],
  },
  {
    id: "offboard-manager-notneeded-runbook",
    date: "2026-07-13",
    title: "Offboard: manager hand-off to Exchange, not-needed steps, full runbook (runner 1.47.0)",
    items: [
      "The Active Directory offboard step now names the manager it clears in the run report, instead of just saying \"cleared manager\"",
      "That manager is handed to the Exchange step, which grants them Full Access to the departing user's shared mailbox - previously, if Exchange ran after AD (a re-run), the link was already gone and the delegate was silently skipped",
      "A system whose credentials are all marked \"not needed\" is now planned as a manual checklist item instead of failing the case at the credential broker",
      "The client runbook now shows systems that run on a case but were never written up in the KB article, flagged \"not in the KB doc\"",
    ],
  },
  {
    id: "coretelligent-post-reset-restore",
    date: "2026-07-13",
    title: "Coretelligent: post-reset restore (TAP, offboard wiring, Delinea creds)",
    items: [
      "The TAP (Temporary Access Pass) onboarding step and the full 12-system offboard wiring lost in the July 13 database reset are restored, now carried by the profile so a reseed keeps them",
      "Delinea credentials rewired from the \\Coretelligent\\IT Support folder: exchange-onprem back to the IAM API AD account, plus Zoom, xMatters and SentinelOne ids recovered",
      "Cloud steps pinned to Coretelligent's own agent again (the Exchange Online cert lives in that box's Windows cert store)",
      "Profiles can now declare runLast (planner runs that system after everything else - used by the offboard notification)",
    ],
  },
  {
    id: "engine-opt-out-parent-inheritance",
    date: "2026-07-13",
    title: "Per-client 'do not use engine' + breakable parent inheritance",
    items: [
      "New 'do not use engine' toggle on a client: the intake sweep and manual import skip its ServiceNow cases (reported as skipped, not failed) - cases already imported are kept",
      "Child clients can break the modeled-by-parent link when they don't match the parent, choosing to keep an editable copy of the parent's systems or start empty",
      "A broken link is honored everywhere inheritance was: case planning, the clients list coverage, the secrets panel, and config review",
    ],
  },
  {
    id: "spanning-otp-broker",
    date: "2026-07-13",
    title: "Spanning force-sync: Delinea-minted MFA codes (PR #24, runner 1.45.0)",
    items: [
      "The Spanning sync login now gets its MFA code minted by Delinea at the exact moment the prompt appears - no authenticator seed is ever stored or handled outside the vault",
      "One automatic retry with a fresh code when a code expires mid-login",
      "Legacy stored-seed secrets keep working as a fallback, with a nudge to enable One-Time Password on the Delinea secret",
    ],
  },
  {
    id: "runner-graph-skew-guard",
    date: "2026-07-13",
    title: "Runner: Microsoft.Graph version-skew self-repair (PR #30, runner 1.44.0)",
    items: [
      "Runners that died at startup with 'Assembly with same name is already loaded' (mixed Microsoft.Graph module versions) now realign themselves automatically before loading",
      "Self-healed Graph module installs are pinned to the host's existing version instead of grabbing the newest - the drift source",
      "The troubleshoot script flags a mixed Graph set with the exact fix",
    ],
  },
  {
    id: "kb-fetch-pipeline",
    date: "2026-07-13",
    title: "KB fetch: faithful steps + systems wired on save (PR #29)",
    items: [
      "Group and DL addresses in a KB now survive the AI parse (no more [user]@domain placeholders in runbook steps)",
      "Saving a runbook creates any modeled systems the client is missing - a KB-sourced client is no longer left with steps but zero systems",
      "New 'Sync systems from runbook' button on the client page to re-wire after a KB edit",
      "Table-of-contents style KBs parse correctly without AI, and the AI extract retries when it drops sections",
    ],
  },
  {
    id: "changelog-page",
    date: "2026-07-13",
    title: "Change log page + send to chat",
    items: [
      "New /changelog page (global admins and above): every shipped feature, newest first",
      "Send any entry to the configured chat channels (Teams, Slack, Zoom, Email) with an optional comment",
      "Audience choice per send: All clients chat, Restricted chat, or both",
    ],
  },
  {
    id: "nickname-persona-lane",
    date: "2026-07-12",
    title: "Nickname-aware onboarding + persona-gated systems (PR #20)",
    items: [
      "Nickname from the intake form now drives the AD first name when filled (Bill, not William)",
      "SamAccountName / UPN / email derive from the nickname: William Smith with nickname Bill = BSmith, not WSmith",
      "New 'by persona' lane: systems like xMatters are set up only for hires whose persona lists them, and cleaned up at offboard",
      "Runner 1.40.0: rehires still match their existing legal-name accounts (no duplicates or collisions)",
    ],
  },
  {
    id: "golive-hardening",
    date: "2026-07-12",
    title: "Go-live security hardening (PR #16)",
    items: [
      "Credential broker now requires authentication; client-scope bypass closed",
      "Auth fails closed everywhere (middleware, installers, enrollment) when secrets are missing",
      "Database indexes on the hot job/audit/case paths; ServiceNow write guard; UI overflow fixes",
    ],
  },
  {
    id: "cred-platform",
    date: "2026-07-11",
    title: "Credential platform (PR #13)",
    items: [
      "Per-system credential test buttons with live results",
      "Rights probes: verify an account can actually do what its runbook needs",
      "Delinea self-check, per-client setup-state tracking, and fleet-wide credential sweeps",
    ],
  },
  {
    id: "cred-expiry-settings",
    date: "2026-07-11",
    title: "Credential-expiry alerts + settings",
    items: [
      "Configurable days-before-expiry threshold for credential alerts, with a sample-alert test button",
      "Stale agents auto-update on heartbeat",
    ],
  },
  {
    id: "cases-v2-access-rules",
    date: "2026-07-10",
    title: "Cases v2, access requests, rules editor",
    items: [
      "Cases v2: readiness dots, multi-select actions, clearer statuses",
      "SSO access requests: unknown sign-ins are held for admin approval on /users",
      "Roles & rules editor: variables and static values; location-to-AD group mapping",
      "AD email write-back after the mailbox exists; agent page redesign; multi-DC failover",
    ],
  },
  {
    id: "pr7-pr10-batch",
    date: "2026-07-09",
    approx: true,
    title: "Licensing, password reset, persona confirm, ServiceNow scan (PRs #7-#10)",
    items: [
      "Group-based license assignment (assign via AD/Entra group, resolved live)",
      "Ad-hoc password reset with a one-time reveal (wiped after viewing)",
      "Persona confirmation flow: hold + suggest when no persona matches a new hire (in review)",
      "'Check ServiceNow' scan marks steps complete from resolved tickets, with lossless undo",
    ],
  },
  {
    id: "security-p0-runner",
    date: "2026-07-03",
    approx: true,
    title: "Security P0 + runner resilience (week of Jun 30)",
    items: [
      "Auth fail-closed, token hygiene, injection guards, database indexes",
      "Super-admin impersonation (view as another operator, mutations blocked)",
      "Runner 1.29 to 1.31.11: Mac fix, AD/directory-sync fixes, PowerShell 7 compatibility on DCs",
      "Runner supervision (systemd / Windows service / DC), Exchange adaptive routing",
    ],
  },
  {
    id: "v2-offboarding",
    date: "2026-06-26",
    approx: true,
    title: "v2 pages + offboarding workflow (week of Jun 22)",
    items: [
      "Clients, Cases, and Audit v2 pages with multi-select",
      "Offboarding workflow end to end; M365 collision handling and mailbox de-dup",
      "M365 conditional licensing; 1Password multi-method auth; SentinelOne offboard",
      "Credential coverage fleet sweep: 724 of 732 secrets verified",
    ],
  },
  {
    id: "systems-editor-kb",
    date: "2026-06-12",
    approx: true,
    title: "Systems editor + runbook parsing (week of Jun 8)",
    items: [
      "Systems editor: model each client's runbook as data (lanes, approvals, secrets, config)",
      "KB article parsing (heuristic + AI hybrid) drafted systems for 141 clients",
      "Runner job claim/result/credential APIs with server-side approval gating; agents UI",
    ],
  },
  {
    id: "runner-generator",
    date: "2026-06-05",
    approx: true,
    title: "Runner service + profile generator (week of Jun 1)",
    items: [
      "PowerShell 7 runner: polls the app, claims jobs, executes Coretelligent.* modules, posts results",
      "Fleet profile generator produced 231 draft client profiles (70 tests)",
      "On-request lanes: intake answers turn optional systems on per case",
    ],
  },
  {
    id: "foundation",
    date: "2026-05-28",
    approx: true,
    title: "Foundation (week of May 25)",
    items: [
      "Repo, data model, and build plan; ServiceNow roster import (182 clients)",
      "Intake-to-case planning: a ServiceNow ticket becomes an ordered step plan",
      "Runbook KB cleanup: 256 articles reviewed, 141 usable client docs",
    ],
  },
];
