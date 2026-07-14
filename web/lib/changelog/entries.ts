// The build change log shown on /changelog (global admins and above) and shareable to the
// configured chat channels. APPEND A NEW ENTRY (at the TOP) whenever a feature/fix ships —
// the page renders this file directly, so the log updates with the deploy that ships the work.
// Give every new entry a `time` (see below): several things ship in a day, and the time is what
// tells them apart. Bullets are sent to chat verbatim as plain text: one line each, no markdown.
export type ChangelogEntry = {
  id: string; // stable slug — the send API references entries by id
  date: string; // ISO date (YYYY-MM-DD) the work shipped; append "~" nowhere — use `approx` instead
  // Local wall-clock ship time, HH:MM on a 15-minute boundary (:00/:15/:30/:45) — round DOWN to the
  // quarter it landed in, so the log never claims a time that hasn't happened yet. Required on
  // anything shipped from 2026-07-13 on; the older entries below that line predate the field.
  time?: string;
  approx?: boolean; // true when the date is a best-effort reconstruction
  title: string;
  items: string[];
};

const QUARTER_HOUR = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export function isQuarterHour(time: string): boolean {
  return QUARTER_HOUR.test(time);
}

// "22:45" -> "10:45 pm". A wall-clock string, never parsed as an instant, so it can't shift by a
// time zone between the server that renders it and the browser that reads it. A malformed time is
// echoed back verbatim rather than formatted: the tests reject one, but this string also goes out
// to the customer chat channels, and a visible "16:3o" beats a confident "4:NaN pm".
export function formatChangelogTime(time: string): string {
  if (!isQuarterHour(time)) return time;
  const [h, m] = time.split(":");
  const hour = Number(h);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m} ${hour < 12 ? "am" : "pm"}`;
}

// The one place "when did this ship" is rendered — the page and the chat message both call this, so
// the two can't drift. Plain ASCII: the chat channels take it verbatim.
export function formatChangelogWhen(entry: ChangelogEntry): string {
  const when = entry.time ? `${entry.date} ${formatChangelogTime(entry.time)}` : entry.date;
  return entry.approx ? `${when} (approx.)` : when;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "changelog-times",
    date: "2026-07-13",
    time: "23:00",
    title: "Change log: the time it shipped, not just the day",
    items: [
      "Every entry now carries the time of day it shipped, to the quarter hour - on a day with eight ships, the date alone told you nothing about the order",
      "The entries already in the log were backfilled from the commit that introduced each one, so the log now reads in true order; entries from before the log existed stay date-only rather than being given invented times",
      "The time goes out with the entry when you send it to chat, on the same 'Shipped:' line",
      "Two entries were dated a day late (2026-07-14, a UTC slip) and are now dated 2026-07-13, when they actually shipped",
    ],
  },
  {
    id: "llm-provider-azure-form",
    date: "2026-07-13",
    time: "22:45",
    title: "Azure AI providers are set up with Azure's own fields, and switching model no longer re-asks for the key",
    items: [
      "Picking the Azure AI preset now asks for what Azure actually gives you - resource endpoint, deployment, API version, key - instead of making you hand-assemble a base URL with the deployment buried in the path. That hand-assembly is how the previous provider ended up 404ing",
      "The base URL is derived and shown live ('Calls: ...') so you can see exactly what will be requested before saving",
      "Change the model by changing the Deployment field - in Azure the deployment is what selects the model. Editing an existing Azure provider re-opens it in the same three fields rather than as a raw URL",
      "Switching deployment no longer forces you to re-type the API key. The re-enter-the-key rule now triggers on a change of HOST rather than any URL change - a path-only edit keeps the key on the same server, so it cannot leak it. Repointing at a different host (or changing the adapter) still demands the key, and an unparseable URL still fails closed",
      "Added a Custom preset for any other OpenAI-compatible endpoint, and an 'Advanced - edit the raw URL' escape hatch on the Azure form",
    ],
  },
  {
    id: "llm-provider-api-version-and-ask",
    date: "2026-07-13",
    time: "22:15",
    title: "LLM providers: an API version field for Azure, ask-it-a-question testing, and a reveal eye on the key",
    items: [
      "Settings - LLM providers now has an API version field. Azure's classic /openai/deployments/... endpoint REQUIRES ?api-version=, and there was no way to set one, so those endpoints could not be registered at all - the only Azure preset worked by pointing at the newer /openai/v1 path that defaults the version for you",
      "The version is sent by the fix lane's real calls too, not just the connection test, so a provider that tests green actually works when the lane uses it",
      "A new 'Azure AI (deployment)' preset fills in the classic deployment URL shape and a working api-version; the existing 'Azure AI' preset is unchanged and still needs no version",
      "Test now has an 'Ask...' box: type any question, send it to that provider, and read the model's actual reply. The plain Test button still sends the cheap 1-token ping. Useful for confirming a provider is really wired to the model you think it is",
      "The API key box has a reveal eye, so you can check what you pasted before saving. It only ever reveals what you just typed - the stored key is still write-only and never leaves the server",
      "The test endpoint still refuses to take a base URL or key from the browser: it always uses the stored provider, so it cannot be used to point an existing key at someone else's host",
    ],
  },
  {
    id: "spanning-force-sync-works",
    date: "2026-07-13",
    title: "Spanning force-sync actually works now (runner 1.50.0)",
    items: [
      "The sync had never once completed - every attempt died at the Microsoft 'Stay signed in?' prompt, which left the browser parked on Microsoft's page so a perfectly good sign-in was reported as a failure. It is now answered",
      "The flow is driven end-to-end by a real test for the first time (against a stand-in Microsoft SSO portal on a separate origin): sign-in, minted MFA code, 'Stay signed in?', redirect, and the sync call itself",
      "It no longer tries to sign in with the Spanning API key - that can never authenticate against Microsoft and repeated attempts are how an account gets locked out. It now asks for a real portal login instead, and says so without ever echoing the value",
      "Still needed from you: put an M365 admin's email + password on the Spanning Delinea secret (PortalUsername/PortalPassword) and enable One-Time Password on it for the MFA prompt",
    ],
  },
  {
    id: "offboard-revoke-mfa-and-sessions",
    date: "2026-07-13",
    time: "21:45",
    title: "Offboarding security: strip the leaver's MFA methods, sign them out of Google (runner 1.49.0)",
    items: [
      "M365 offboard now removes the leaver's registered second factors (phone, Authenticator, FIDO2, software OATH, Windows Hello) - previously they stayed on the account and went live again the moment anyone re-enabled it, and stayed usable for self-service password reset",
      "Which KINDS of factor were removed is recorded as case evidence (types only - a phone number is never stored)",
      "Google offboard now signs the user out everywhere, revoking their sessions and refresh tokens - suspending an account blocks new sign-ins but does NOT invalidate tokens already issued, so a departing user's phone could keep syncing mail",
      "Both need one extra permission (Entra: UserAuthenticationMethod.ReadWrite.All; Google: the admin.directory.user.security scope). Neither is required: a tenant that hasn't granted it keeps working, and the offboard warns in plain words that the factors or tokens are still live",
    ],
  },
  {
    id: "framework-systems-are-checklist-steps",
    date: "2026-07-13",
    time: "19:45",
    title: "Case resolution + ServiceNow are checklist steps again (not fake API steps)",
    items: [
      "Case resolution was wired as an automated step on 129 clients, but no executor exists for it - every case dispatched a job that came straight back as 'skipped - no executor', and operators were hand-marking it done",
      "Those 130 rows are now manual checklist steps, so the run report prompts you to close the ticket instead of showing a misleading skipped line",
      "The Modules page no longer claims ServiceNow and Case resolution are 'built' - nothing in the app writes a ServiceNow ticket's state today (work notes only, and only when write-back is enabled)",
      "Next up: a real ServiceNow write executor to close the ticket automatically - blocked on a write-capable API key",
    ],
  },
  {
    id: "exchange-manager-name",
    date: "2026-07-13",
    time: "16:45",
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
    time: "16:30",
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
    time: "16:30",
    title: "Coretelligent: post-reset restore (TAP, offboard wiring, Delinea creds)",
    items: [
      "The TAP (Temporary Access Pass) onboarding step and the full 12-system offboard wiring lost in the July 13 database reset are restored, now carried by the profile so a reseed keeps them",
      "Delinea credentials rewired from the \\Coretelligent\\IT Support folder: exchange-onprem back to the IAM API AD account, plus Zoom, xMatters and SentinelOne ids recovered",
      "Cloud steps pinned to Coretelligent's own agent again (the Exchange Online cert lives in that box's Windows cert store)",
      "Profiles can now declare runLast (planner runs that system after everything else - used by the offboard notification)",
    ],
  },
  {
    id: "import-clients-by-coreid",
    date: "2026-07-13",
    time: "16:30",
    title: "Add client: import by CORE id, built out from the KBs automatically",
    items: [
      "Paste one CORE id or a list of them into Add client - each is looked up in ServiceNow, created, and built out from its onboarding and offboarding KB articles (runbook sections plus the systems they imply) without anyone hunting for KB numbers",
      "It also fills in clients you already have: a client the roster sync created as a bare row (no runbook, no systems, cases that plan no steps) gets built out, while any runbook that already exists is left strictly alone - a re-import never overwrites what you have edited",
      "Results stream in one client at a time: a single import drops you on that client's page, a batch leaves a summary table showing what was built, what already existed, and what could not be found",
      "A KB that does not look like a real runbook guide (a request form, say) is NOT imported - it is named on the row for you to review, rather than quietly becoming client config that a live case would run against",
    ],
  },
  {
    id: "engine-opt-out-hardening",
    date: "2026-07-13",
    time: "16:30",
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
    id: "engine-opt-out-parent-inheritance",
    date: "2026-07-13",
    time: "16:00",
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
    time: "13:00",
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
    time: "13:00",
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
    time: "13:00",
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
    date: "2026-07-12",
    time: "23:30",
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
