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
    id: "import-clients-by-coreid",
    date: "2026-07-13",
    title: "Add client: import by CORE id, built out from the KBs automatically",
    items: [
      "Paste one CORE id or a list of them into Add client - each is looked up in ServiceNow, created, and built out from its onboarding and offboarding KB articles (runbook sections plus the systems they imply) without anyone hunting for KB numbers",
      "It also fills in clients you already have: a client the roster sync created as a bare row (no runbook, no systems, cases that plan no steps) gets built out, while any runbook that already exists is left strictly alone - a re-import never overwrites what you have edited",
      "Results stream in one client at a time: a single import drops you on that client's page, a batch leaves a summary table showing what was built, what already existed, and what could not be found",
      "A KB that does not look like a real runbook guide (a request form, say) is NOT imported - it is named on the row for you to review, rather than quietly becoming client config that a live case would run against",
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
