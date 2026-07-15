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
    id: "documents-upload-redline-progress",
    date: "2026-07-15",
    time: "22:00",
    title: "Documents: upload your own edits, redline any two versions, and a clearer 'Update with AI'",
    items: [
      "'Update with AI' now shows a progress window while it runs - reading the change log, asking the model (with a live timer), parsing the reply, building the redline - instead of a button that just says 'Generating…'",
      "Fixed the AI dropping large parts of a document: it now has room to reproduce the whole document and is instructed to copy every section through verbatim, and a draft that comes back much shorter than the current version is blocked from publishing until you review the redline and confirm",
      "New 'Upload' button: download a document, edit it in Word or a text editor, and upload it back (.docx or .md). It becomes a draft you review and publish like any other - and old versions are always kept",
      "Redline any two versions from the version history against each other, not just a pending draft - handy for seeing exactly what changed between v1.2 and v1.5",
    ],
  },
  {
    id: "spanning-force-sync-central-only",
    date: "2026-07-15",
    time: "21:45",
    title: "Force Spanning sync is now correctly a central-runner job — the run report stops showing it as waiting on a client's on-prem agent",
    items: [
      "A pending force Spanning sync showed 'waiting for <the client's on-prem agent> to claim it' — but that agent has no browser automation and can never run it. It always ran on the central runner; only the message named the wrong agent (the client agent polls more often, so it won the 'claims it next' pick). The pending line now names the central, browser-capable runner",
      "It also fixes a real stall: for a client whose cloud work is pinned to its own agent (run-cloud-on-own-agent), a force sync was pinned away from the central runner AND withheld from the client's browser-less agent — so nobody could claim it and it sat pending forever. Force sync is now always routed to the central runner, so it runs",
      "No change for the usual client — a force sync already ran on the central runner; this just makes the routing and the on-screen reason agree",
    ],
  },
  {
    id: "spanning-force-sync-fixed",
    date: "2026-07-15",
    time: "21:30",
    title: "Force Spanning sync works again, and no longer piles a new warning step onto the case each time",
    items: [
      "Force Spanning sync had stopped working across every client: the Central Cloud Runner (the only agent that runs browser automation) had a half-installed Playwright, so the browser flow crashed the instant it started and reported the useless 'produced no result (Node.js v24.14.0)'. Brock Built's UM0029776 is where this surfaced",
      "Fixed the runner directly (reinstalled Playwright), so force sync runs to completion now. To stop it recurring: the agent no longer advertises 'browser' when Playwright is only half-installed, and self-heals on the next restart instead of claiming jobs it can't run",
      "The browser flow now reports the real reason it couldn't run (e.g. 'Playwright is not installed - run npm install') instead of a bare crash banner, so a future break is diagnosable at a glance",
      "Triggering a force sync used to append a brand-new 'spanning-force-sync' step every time - UM0029776 had two. It now re-uses a single step per case (re-running it in place), shown once",
      "That step now reads 'Spanning force sync' and is nested under the Spanning step as a sub-action, instead of a bare 'spanning-force-sync' line sitting at the top level",
      "Agents pick up the self-heal on runner 1.63.0",
    ],
  },
  {
    id: "documents-versioned-in-app",
    date: "2026-07-15",
    time: "21:30",
    title: "Documents: the IAM Engine reference docs now live in the app - versioned, downloadable, and updatable with AI",
    items: [
      "The four reference documents (client overview, setup and configuration guide, security design, and the internal reference) are now a Documents page in the app, instead of Word files passed around by hand",
      "Each document is versioned in-app. The current version renders in the browser, with a version-history table on the document showing every version, its date, who published it, and what changed",
      "Download any document as Word (.docx), a self-contained web page (.html, which prints cleanly to PDF), or Markdown - always regenerated from the current version, so a download is never stale",
      "'Update with AI' reads the change-log entries logged since the document was last revised, proposes a revised draft, and shows you a diff plus a change summary. You review and Publish (a minor or major version bump) or Discard - nothing publishes without a human",
      "Access follows role: any engineer and up can read and download the client-facing docs; the internal reference is visible to global admins and up only; running an AI update and publishing are global-admins-and-up",
      "Seeded at v1.0 from the existing documents. The AI update uses the LLM provider configured in Settings",
    ],
  },
  {
    id: "agent-url-migration",
    date: "2026-07-15",
    time: "21:30",
    title: "Agents can move to a new app domain by themselves - no reinstall on each on-prem network",
    items: [
      "Set a new app URL under Settings > Agent domain migration. Prove it on one agent with the Migrate button on the Agents page, then enable it fleet-wide.",
      "Each agent verifies it can reach the new URL, rewrites its own scheduled task / launchd / systemd entry, and switches - the old URL is removed once it reports in on the new one.",
      "If the new URL is unreachable or the rewrite fails, the agent stays on the old URL and the failure shows on its row in Agents; it retries on the next heartbeat.",
      "The Agents page shows each agent's current base URL and its migration status, so you can watch the fleet converge before retiring the old host. Needs runner 1.62.0.",
    ],
  },
  {
    id: "ad-dc-optional",
    date: "2026-07-15",
    time: "21:15",
    title: "Active Directory no longer needs the ad-dc credential to run - a domain-controller agent signs in as itself",
    items: [
      "Marking the ad-dc credential 'not needed' used to break Active Directory - it forced AD to a manual step, or (with a half-cleared credential) failed the case at 'brokering credentials' before the agent ever ran. Brock Built's onboard (UM0029763) was stuck on exactly this",
      "ad-dc is now OPTIONAL. On a domain controller - where the agent almost always runs - the runner authenticates as its own built-in SYSTEM identity (which IS the directory's full-control account) and needs no stored credential at all. So an unset, not-needed, or missing ad-dc is a non-event now, not a failure",
      "When a client HAS wired ad-dc (an agent on a member server, not a DC, that genuinely needs a domain login) it's still attached and used - so those clients are unaffected. The only behaviour change: a member-server agent that skips ad-dc now fails at run time with a clear 'this isn't a domain controller - wire ad-dc' message instead of being blocked earlier as a manual step",
      "The client page stops showing a false 'ad-dc credential not set' / 'AD not ready' for domain-controller clients - ad-dc reads as an optional credential, like the Spanning portal login",
      "We reused the existing optional-credential mechanism rather than adding a new 'required' switch to every credential - one small list entry instead of a schema change and a new toggle",
      "To pick this up on an existing case, re-plan it (the AD steps then drop ad-dc and become runnable); agents need runner 1.60.0",
    ],
  },
  {
    id: "build-from-systems-preview",
    date: "2026-07-15",
    time: "21:15",
    title: "Build from systems now shows a preview you can edit before it saves, instead of overwriting the runbook the moment you click",
    items: [
      "On a client page, the 'Build from systems' button used to replace the onboard AND offboard runbook the instant you confirmed a browser popup - no chance to see what it generated first",
      "It now opens a preview dialog with an Onboard and an Offboard tab, one section per participating system. You can reorder, rename, relink to a different system, and add or remove steps - the same editing you already had on the paste-a-runbook flow, now reused here",
      "Nothing is written until you press Save; Cancel discards the whole thing and leaves the stored runbook untouched. Save replaces both actions' runbooks with what you see",
      "If a tab has no participating systems it says so and is skipped on save; if you delete every section in a tab, that action is left unchanged rather than wiped",
    ],
  },
  {
    id: "agent-restart-status-visible",
    date: "2026-07-15",
    time: "14:15",
    title: "The Agents page now shows a 'restart queued / restarting' status when you restart a runner",
    items: [
      "Clicking Restart on a runner used to give no visible feedback in the newer Agents view (v2) - the action lives in the 'Actions' menu, which closes the moment you click, so the 'Restarting...' label was hidden and it looked like nothing happened. The restart was actually queued; you just couldn't see it",
      "A restart status line now shows on the runner's row itself, in both the classic and v2 views: 'restart queued - waiting for the runner to poll', then 'restarting - re-launching', then 'restarted - runner back online', with the operator who requested it",
      "The row refreshes on its own while a restart is in flight (same 4-second live poll the Update flow already used), so the status advances and clears without a manual page refresh",
    ],
  },
  {
    id: "ad-folder-tree-picker",
    date: "2026-07-15",
    time: "14:00",
    title: "Pick any AD folder for onboarding - and the pick now actually takes effect",
    items: [
      "\"Refresh AD objects from DC\" used to list only OUs, so a client whose users live in the default Users container (a CN=Users folder, not an OU) had nothing to pick. PureTech's onboard (UM0029706) failed on exactly this - 'OU=Users' does not exist. Discovery now enumerates the WHOLE tree: OUs, containers (Users, Computers, Builtin, Managed Service Accounts), and the domain root",
      "The folder tree labels containers and the domain root correctly (not just OUs), with an icon per kind so a container reads differently from an OU at a glance",
      "You can now set the onboarding OU/folder on the Active Directory system in Edit systems - type a full DN or Browse the discovered tree. This is the value the runner actually uses (config.onboard.ou)",
      "That closes a silent trap: an OU set under Roles & rules was overridden at run time by the system's own base OU, so edits there appeared to do nothing. Roles & rules now shows a warning when a base OU is set, pointing you to Edit systems - the one place the change takes effect",
      "Agents need runner 1.61.0 for the fuller folder discovery",
    ],
  },
  {
    id: "exo-pin-selfheal",
    date: "2026-07-15",
    time: "12:00",
    title: "Runner self-heals the Exchange Online module pin",
    items: [
      "Exchange jobs no longer fail with \"does not contain a method named 'GetResponseHeader'\" on hosts that only had the broken ExchangeOnlineManagement 3.10.0 (which puretech/core2104 hit)",
      "The runner now installs the PS7.6-safe 3.9.2 pin at startup when it is missing, instead of warning and silently falling back to the broken build (runner 1.61.0)",
    ],
  },
  {
    id: "optional-cred-empty-label",
    date: "2026-07-15",
    time: "11:00",
    title: "An empty optional credential now reads '(optional)' in grey, on the client and the case",
    items: [
      "When a credential is optional (like ad-dc, or the Spanning portal login) and hasn't been wired, its name now shows a grey '(optional)' next to it - on both the client's credentials panel and a case's credentials - so a blank one reads as 'fine to leave unset', not as a missing credential",
      "On the client this replaces the old always-on 'optional' pill: the hint now appears only when the credential is actually empty. Wire it and the '(optional)' marker goes away",
      "Display only - nothing about how credentials are brokered or tested changed",
    ],
  },
  {
    id: "runner-version-startup-log",
    date: "2026-07-15",
    time: "10:45",
    title: "The server now logs which runner version it serves to agents, every time it starts",
    items: [
      "On startup the app prints one line - e.g. 'serving v1.60.0 · build acf9ba83 · 68 files' - naming the exact runner version and build it will hand to agents. Agents self-update from whatever the app serves off its own disk, so this line is the ground truth for what your agents will update to",
      "This makes a stale deploy obvious: if you ship a runner change but the server still logs the old version on restart, the app is running pre-pull code and agents will never see the update - pull and restart the app onto the new code first",
      "Log only - no behaviour change, nothing new exposed in the UI or to agents",
    ],
  },
  {
    id: "run-log-fixed-lines-populate",
    date: "2026-07-15",
    time: "09:00",
    title: "Marking a run-log error 'Fixed' now moves it into the Fixed lines table (v2 run log)",
    items: [
      "On the v2 run log, clicking '✓ Fixed' set the line as resolved but the line then disappeared instead of moving to the 'Fixed lines' section below. The Fixed section only ever filled in if you also ticked the 'fixed' filter - so in normal use a fixed error just vanished",
      "The Fixed lines section now loads the resolved lines on its own, every time, independent of the filter. Mark an error Fixed and it drops off the working list and shows up under Fixed lines right away",
    ],
  },
  {
    id: "audit-actor-provenance",
    date: "2026-07-15",
    time: "02:00",
    title: "The audit log can now tell you who did it - before, half of it just said 'ui'",
    items: [
      "Nobody could answer 'who created this case?'. Cases carried no creator at all - the only trace was the case.plan audit row written in the same second, and you had to know to go looking for it. Cases now record who opened them and how (by hand, imported from ServiceNow, pulled in by the poller, or the simulator), as columns on the case itself",
      "The existing 21 cases were backfilled from their audit history, so the answer is there for cases that already exist - not just new ones",
      "Editing a runbook was audited as 'ui' - no name. Every runbook, systems, secrets, rules and client edit now names the engineer who made it. Same for approving a destructive step, revealing a password, and re-running a job, all of which recorded the action but not the person",
      "A runbook save now records WHAT changed, not just that it was saved: the sections and steps added, removed, renamed and reordered. A save is a delete-and-recreate, so a section that quietly disappears is how a client stops getting a system provisioned - and until now the log could only say 'someone re-saved the runbook'",
      "Deleting an agent, re-scoping one to a different client, changing runner priority, and issuing an enrolment token were not audited at all. They are now",
      "The case list says 'Created by' for a hand-keyed case instead of mislabelling it 'Imported'",
    ],
  },
  {
    id: "manual-case-numbers-and-fix-status",
    date: "2026-07-14",
    time: "21:15",
    title: "Manual cases now get an IAM number, and a 'Fix with AI' stays marked running when you come back to the run log",
    items: [
      "A case you create by hand (not from a ServiceNow ticket) used to have a blank case number. It now gets an auto-assigned number - IAM0000001, IAM0000002, and so on - written into the same field ServiceNow cases use, so every case has exactly one number to quote. ServiceNow-sourced cases keep their own UM number untouched",
      "The IAM numbers come from a dedicated counter, so they stay contiguous: a ServiceNow case in between does not burn a number and leave a gap",
      "On the run log, clicking 'Fix with AI', navigating away, and coming back used to lose the queued/analyzing indicator - the line looked untouched even though the fix was still running. The page was serving a cached copy rendered before the fix existed. It now refreshes on click, so the running/queued state (and a ready-to-review proposal) is still there when you return",
    ],
  },
  {
    id: "ad-ambient-auth-first",
    date: "2026-07-14",
    time: "21:15",
    title: "AD onboarding was failing on the domain controller because we insisted on handing it a password it did not need",
    items: [
      "Brock Built's AD step (UM0029763) failed with 'Authentication failed on the remote side' and then 'the user has not been authenticated'. Neither is Active Directory rejecting the operation - both are the login itself being refused, before AD ever looked at what we were asking for",
      "The agent runs as SYSTEM on the domain controller, which IS the directory's own SYSTEM account - full control, over an encrypted Kerberos connection, needing no password at all. We were overriding that with the stored ad-dc credential, and Delinea's Active Directory template keeps the domain in a separate field, so the username we passed was a bare account name with no domain on it. A bare name cannot use Kerberos, so the connection drops to the old NTLM method, and a hardened DC refuses that outright. We were handing AD a worse identity than the one the process already had",
      "The runner now uses its own identity on a domain controller and keeps the stored credential only as a fallback for when the DC refuses it. Off a domain controller it still leads with the stored credential",
      "Two guard rails matter more than the fix itself. First: we only prefer our own identity where we KNOW it is privileged - running as SYSTEM, on a writable domain controller. A read test cannot establish that, because every account that can log in can read the directory; on a member server SYSTEM is just the machine account, which reads fine and cannot create a single user. Preferring it on a read test would have gone green and then failed access-denied halfway through a case",
      "Second: off a domain controller, a refused credential now FAILS LOUDLY instead of quietly falling back to the machine account. Falling back would turn 'your stored ad-dc password is stale' into a half-finished offboard that dies partway through - the worst possible way to find out",
      "When the stored credential IS used, a bare username now gets its domain attached from the secret's Domain field. We attach exactly one form and try it once: probing several variants of the same password would have counted as several failed logons every time, and ad-dc is a SHARED account on many clients (also used for on-prem Exchange), so a stale vault password would have walked it straight into a domain lockout",
      "If nothing authenticates, the error names both identities that were tried and what each was told, and distinguishes 'the DC is unreachable' from 'the credential is wrong' - instead of a bare 'authentication failed' that never said who we were even logging in as",
      "The AD connection test was auditing the wrong account: it always checked whether the ad-dc account could create users, even where the runner now signs in as SYSTEM and never touches that credential. It now checks the rights of whichever identity we actually authenticate as",
      "A green AD connection test was part of why this hid: it only ever proved we could READ the domain. Brock Built has no onboarding OU configured, so the test's 'can this account create users' check was skipped entirely and the test still went green",
    ],
  },
  {
    id: "offboard-licence-fleet-sweep",
    date: "2026-07-14",
    time: "17:45",
    title: "We were not reclaiming the leaver's licence for 128 of 134 clients - and the one rule that stops us destroying their mailbox was dead code",
    items: [
      "BayPine's missing 'remove the licence' step turned out not to be a BayPine problem. Of 134 clients with a 365 offboard, only SIX removed the leaver's licence or converted their mailbox - while 203 of 230 runbooks say to remove it. The profile generator produced the STEPS but never the CONFIG, and licence removal is opt-in, so for ~128 clients we blocked sign-in and then quietly left a paid, licensed mailbox behind. Nothing failed. Nothing warned",
      "114 clients are now configured from what their runbook actually says: block sign-in and strip groups (365) -> convert the mailbox to shared (Exchange) -> remove the licence (Entra), with the licence step DEPENDING on the mailbox step so it cannot run first",
      "Order is not a detail here. Taking the licence off a mailbox that is not yet shared destroys it - Exchange purges an unlicensed, unconverted mailbox once the 30-day grace expires. Most of the six configured clients (Regal, Six One, Yuma) had exactly that ordering, and had been getting away with it inside the grace window",
      "The safety rule that should have caught this was dead. The 365 module keeps the licence when a mailbox is too big to become shared - but the runner never passed it the mailbox size, so it always read 0 and could never fire. Exchange knew the size all along and had nobody to tell",
      "Now, if the mailbox cannot be converted - too big, or the conversion has not run yet - the licence is KEPT and the step raises a warning for an engineer to pick up, rather than silently doing the destructive thing. That holds even if a client's ordering is wrong, so a mis-configured profile is now safe instead of dangerous",
      "Clients whose runbook FORBIDS removing the licence were not automated - a regex cannot tell 'remove the licence' from 'do NOT remove the licence', so those were read by hand. Carrington Coleman ('NOTE: Do NOT remove the license') keeps its licence, and ACORE ('do not remove the license yet') has it removed in the later step, after the mailbox",
      "Carrington Coleman now gets a MANUAL checklist item on every offboard that says the licence was left in place on purpose, and quotes the runbook line. Without it, 'we deliberately left the licence' and 'the engine silently failed to remove the licence' look identical on a case - and the second one is the bug this whole batch exists to kill. Manual steps also now show their instruction note on the run report instead of rendering as an empty line",
      "Yuma had a circular dependency (Exchange waited on Entra while Entra waited on Exchange) that would have deadlocked its offboard. Fixed, and the sweep now refuses to create one",
    ],
  },
  {
    id: "accepted-failure-case-status",
    date: "2026-07-14",
    time: "17:00",
    title: "A case could say 'failed' on the list while every step inside it read green - and nothing could ever clear it",
    items: [
      "INC0859438 showed 'failed' on the cases list, but opening it showed every step succeeded. Both screens were telling the truth about different things. Two steps (Duo, LogicMonitor) really did fail, and an engineer then hit 'Ignore' on both - which flips a step to verified on the case page, but never touches the underlying job. The badge on the list is derived from the jobs, so it stayed red, and no re-run, re-plan or later success could ever clear it",
      "Ignoring a failure now clears it from the case badge too, and un-ignoring puts it back. The dependency gate already treated an accepted failure as satisfied - the case status was the one place that did not. It is now the single place the badge is derived, so the overlay cannot be forgotten again",
      "The two cases already stuck this way (INC0859438, UM0029695) have been corrected - they now read 'completed' and 'needs manual'",
      "Fixed the failure underneath it as well. Duo and LogicMonitor are done by hand for Coretelligent, so their credentials are marked 'not needed' - but those steps had been planned while a credential still existed, so the engine dispatched them anyway, asked for a credential that was not there, and failed the whole case over work a human was always going to do",
      "A step whose every credential is marked 'not needed' is now demoted to a manual checklist item before it is ever dispatched, with a note saying to do it by hand. It cannot fail a case again",
    ],
  },
  {
    id: "baypine-run-fixes-adopt-retry-archive",
    date: "2026-07-14",
    time: "16:45",
    title: "A rehire's account was left disabled, every Spanning offboard left a billable seat, and a self-healing step was crying wolf every 15 minutes",
    items: [
      "Onboarding a REHIRE could finish 'completed' with an account that cannot sign in. When an existing same-name account is adopted, we stamped our marker and moved on - but only the CREATE path ever switched the account on, and a rehire's old account is disabled. The validation read-back said 'AccountEnabled: false' on every run and nothing ever acted on it. Adopting now enables the account (and a re-run is a no-op if it already is)",
      "Every Spanning offboard has been leaving the leaver on a billable, still-backing-up Standard seat - fleet-wide, silently. Kaseya's API cannot CONVERT a Standard licence to an Archive one, so the 'swap to Archive' call was a no-op, and the vendor said so (licensed=false) while we logged a reassuring 'the read-back will confirm it' and reported success. The step now re-reads the tier and, if it is still Standard, says so as a WARNING with the exact manual fix (Spanning console -> Manage Licenses -> Activate Archived). It deliberately does NOT force the swap by unassigning first: Kaseya warns that can delete the backups, and retention is the entire point of the step",
      "A step waiting on a vendor sync no longer reports as a failure. Spanning and Mimecast discover a new 365 user on their own schedule, so the executors say 'not yet, ask me again in 15 minutes' - and the app was logging every one of those as a run-log warning AND firing a chat alert, every 15 minutes, for a step that fixes itself. It now shows as 'retrying' and stays quiet until it either lands or gives up",
      "...and it can now actually give up. The 16-attempt cap was dead code: re-queueing a job deleted its attempt counter, so the count reset to 1 every time and 'attempts < 16' was true forever. A user the vendor will NEVER discover (an unlicensed 365 user has no mailbox, so Spanning and Mimecast cannot see them) retried every 15 minutes indefinitely. The count now survives the re-queue; after ~4 hours the wait ends and raises a real warning",
      "Mimecast now rides out a gateway blip. A single HTTP 504 ('Connection to service has timed out') failed a whole onboard - only 401 was ever retried. 429/502/503/504 now back off and retry (500 does not: it can mean the request was processed and then blew up). The same 502/504 gap is closed in the 365 write path",
      "When Graph refuses to read a leaver's MFA methods, the warning now names the permission to grant (UserAuthenticationMethod.ReadWrite.All). It was only matching one of Graph's two ways of saying 'denied', so the other one produced a vague 'could not read MFA methods' with no way forward",
    ],
  },
  {
    id: "offboard-license-after-shared-convert",
    date: "2026-07-14",
    time: "16:45",
    title: "BayPine was never removing the leaver's licence - and the rule meant to stop us destroying a mailbox was dead code",
    items: [
      "BayPine's runbook says 'remove the user's licence from their email'. It never happened. Their profile was generated with NO offboard config at all - just 'when: always' - and the executor only removes a licence when the config asks for it. Nothing failed and nothing warned; the work was simply never requested. The mailbox was never converted to a shared mailbox either, for the same reason",
      "BayPine now does: block sign-in and strip groups (365) -> convert the mailbox to shared (Exchange) -> remove the licence (Entra). The licence step is wired to depend on the mailbox step, so it CANNOT run before the conversion - the ordering is enforced by the plan, not by hoping the steps line up",
      "The safety rule that was supposed to prevent this was dead code fleet-wide. The 365 module keeps the licence when a mailbox is too big to become shared - but the runner never passed it the mailbox size, so it always read 0 and the rule could never fire. Exchange knew the size all along and had nobody to tell. It now hands it to the licence step, along with whether it actually converted",
      "Taking a licence off a mailbox that is NOT shared destroys it: Exchange purges an unlicensed, unconverted mailbox once the 30-day grace expires. The licence step now refuses to do that - it keeps the licence, says why on the run report, and tells you what to do instead",
      "And a profile that says 'do not remove the licence here, a later step does it' is now obeyed. MarketScience's profile has said exactly that for months and the code ignored it, stripping the licence in the very step the profile forbade",
    ],
  },
  {
    id: "runlog-bulk-copy",
    date: "2026-07-14",
    time: "16:00",
    title: "Tick several run-log errors and copy them all in one click",
    items: [
      "The run log already let you multi-select open errors and warnings, but the only thing you could do with a selection was mark it Fixed. Copying the failures out - into a ticket, a chat, or a prompt - meant clicking the per-line copy button once per line",
      "There is now a Copy button in the selection toolbar, to the left of Fix: tick as many lines as you like and 'Copy 4' puts all four on the clipboard at once, each with its module, case number, message, error and credential detail, exactly as the per-line copy gives them",
    ],
  },
  {
    id: "graph-signins-module-missing",
    date: "2026-07-14",
    time: "15:45",
    title: "Offboards were leaving the leaver's MFA registered, and warning about it on every single run",
    items: [
      "Every 365/Entra offboard warned \"could not read MFA methods ... the term 'Get-MgUserAuthenticationMethod' is not recognized\", which reads like a typo but is not: the Microsoft.Graph.Identity.SignIns module - the one that provides the MFA cmdlets - simply was not installed on the agent. The sign-in block, the session revoke and the group removal all worked; the leaver's second factors stayed registered",
      "Why it never fixed itself: the startup repair only ALIGNS the Graph submodules that are already installed, it never ADDS one that is missing. Agents enrolled before that module joined the installer's list therefore never got it, and never would have",
      "And the safety net could not catch it either. The runner has a self-heal that installs a missing module when a cmdlet is not found - but the 365 module caught its own error and turned it into a warning, so the self-heal never saw it. The one mechanism designed to fix this was the one thing guaranteed not to run",
      "The runner now installs any required Graph submodule that is missing at startup, pinned to the version of the others (mixing versions is what causes the 'assembly already loaded' crash). Let the agent self-update and restart, then re-run the 365 step and the second factors are removed for real",
      "The warning itself now names the actual cause and the fix, instead of quoting a raw PowerShell error at you",
    ],
  },
  {
    id: "offboard-target-picker",
    date: "2026-07-14",
    time: "15:15",
    title: "When we can't tell WHICH Parth Shah to offboard, we now ask you instead of guessing (or quietly doing nothing)",
    items: [
      "Until now, if the name on the ticket matched two people the step said 'ok' and did nothing, and if it matched nobody it said 'user not found - nothing to offboard'. Both went GREEN. A case could reach 'completed' with the leaver's account still live and signed in",
      "Now the step stops, the case is held, and the run report shows you the actual people it found - name, email, job title, department, and whether the account is still enabled - so you pick the right one. Nothing is touched until you do",
      "It handles the misspelling case too, which is the common one: ServiceNow says 'Parth Shah', the directory says 'Parth K. Shah', and an exact search finds nobody. Rather than give up, the module searches again on each part of the name and offers you the near-matches. There's also a box to type a UPN by hand if the person isn't in the list",
      "Your pick is saved on the CASE, not the step - every system resolves the leaver from the same place - so one choice unblocks 365, Exchange, AD, Slack, Duo and the rest at once. The whole case then re-runs from the top, so a step that already quietly no-op'd against the unknown user gets done properly",
      "Deliberate: a single near-match still asks. Auto-picking a fuzzy match is exactly how you offboard the wrong person, and that one doesn't undo. An EXACT single match still runs straight through, so nothing slows down on the normal path",
      "Who picked whom is audited (case.offboard_target.select) - choosing who gets locked out is a decision that deserves a name against it",
    ],
  },
  {
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
  },
  {
    id: "offboard-identity-resolution",
    date: "2026-07-14",
    time: "13:30",
    title: "Offboards were failing (and, worse, quietly doing nothing) because the leaver was only ever a name",
    items: [
      "An offboard case reached the runner carrying the departing person as a NAME ('Parth Shah') and nothing else - no email, no UPN. The 365 step died on it with 'The property UserPrincipalName cannot be found on this object' (UM0029766). 15 of the 24 runner modules had the identical bug on their offboard path, so the same case would have failed again at Exchange, AD, Spanning, Slack, Duo, Mimecast, Adobe, Google, Egnyte, Perimeter81, KnowBe4, LogicMonitor, HubSpot and Jira",
      "ServiceNow now resolves the leaver's actual EMAIL from the contact record on the ticket (the same lookup already used for the manager and the mirror user), so every offboard step matches on an email instead of guessing at a display name that is often spelled differently in 365 than in ServiceNow",
      "The nastier half of this: Active Directory and Exchange did NOT crash - they looked for a field the case never had, found nothing, and reported the step as 'ok, no user identity on the case' while the account stayed live. An offboard that reports success without disabling anything is the worst way for this to fail, so a step that cannot identify WHO to offboard now fails loudly instead of going green",
      "The verify pass had the same bug and it was the more dangerous one: the validators run on the same payload, so they crashed too - and where they did not crash, a blank email matched nobody, which reads as 'already gone' and would have rubber-stamped an offboard nobody performed. Unresolvable is now an explicit fail, never a pass",
      "Existing 365 / Exchange / AD cases run without being re-imported (they fall back to the name on the ticket and resolve it against the live directory). The email-keyed SaaS steps - Slack, Duo, Adobe, Spanning and the rest - can only match on an email, so a case that predates this change needs a re-import (or the email set on the case) before those steps will run",
    ],
  },
  {
    id: "adobe-org-id-accountid",
    date: "2026-07-14",
    time: "13:15",
    title: "Adobe: the org id lives in accountid, and the runner now looks there (it never could before)",
    items: [
      "Adobe needs your organization id (…@AdobeOrg) in the URL of every call. The runner read it from a field literally named OrgId - but Delinea's 'Automation - API' template has no OrgId field, so in practice it goes in accountid. Every Adobe secret created from the stock template therefore handed the runner an empty org id and failed against a malformed URL. It now reads accountid, and about a dozen other spellings",
      "It also finds the org id by the SHAPE of the value: any field ending @AdobeOrg is recognised as the org id, whatever the field is called. A field name is a convention an operator can get wrong; the value's format is not",
      "When there genuinely isn't one, the error now names accountid, lists the fields the secret actually has, and points at /help/adobe - instead of a 403 from a URL with a hole in it",
      "Adobe was the only major system with NO app-side field check, so a misfiled org id sailed through 'wired' and only surfaced on a live run. It has one now",
      "To be clear about what you do NOT need to store: no access token (the runner mints a short-lived one on every connect), no scopes (they're fixed), and no technical account id/email - those belong to Adobe's deprecated Service Account JWT flow. If your credential came with a technical account id and a private key, it's the wrong integration type",
      "Separately, fixed 3 logging calls that would THROW instead of logging - Write-CtgLog took the level before the message, so passing the message first died on the level's validation. All 3 were inside catch blocks, so the only thing they could break was the code trying to report a problem",
    ],
  },
  {
    id: "slack-executor-and-manual-flip",
    date: "2026-07-14",
    time: "10:15",
    title: "Slack is automated, and 27 steps that were silently doing nothing are now real checklist items",
    items: [
      "Slack now runs for real (13 clients): onboard invites the member, offboard DEACTIVATES them - which in Slack switches the account off and keeps their messages and files, rather than erasing the person. It matches on email (handles collide and get renamed), and it reactivates a returning employee's existing account instead of creating them a second identity",
      "27 steps across 5 systems (sharepoint 10, mdm 7, printix 5, archive 3, notion 2) were marked as automated but had NO credential and NO configured behaviour - so every case dispatched a job that came back 'skipped: no executor' and the step read as HANDLED on the run report when in truth nobody had done it. They are now manual checklist items an operator actually ticks off",
      "Only rows with no credential were flipped: if someone had wired a secret, that system was left alone rather than silently downgraded mid-setup",
      "Slack's SCIM API needs a Business+ or Enterprise Grid plan - on Pro or Free it 404s no matter how good the token is. The connection test names that explicitly instead of blaming the credential, so nobody spends an afternoon rotating a token that was fine",
      "Not done, and why: Salesforce, Jira and HubSpot have finished modules but NO client uses them - the only 'Salesforce' in any runbook is an AD group name and a job title. Wiring them would have meant inventing client configuration nobody asked for. Say the word if a client actually uses one",
    ],
  },
  {
    id: "llm-model-aware-requests",
    date: "2026-07-14",
    time: "10:00",
    title: "The gpt-5 models work now: pick a deployment from a dropdown, and the request adapts to the model",
    items: [
      "gpt-5.4 and gpt-5.6-luna could not be used at all. Both reject 'max_tokens' (they require 'max_completion_tokens'), and gpt-5.6-luna additionally rejects 'temperature' - and the app hardcoded both. gpt-4o accepts them, which is why only it worked",
      "Requests now adapt to the model: we send our best guess, and if the model objects we do exactly what its error says and retry. What we learn is remembered, so the wasted first attempt happens at most once. A brand-new model works with no code change - the error is the authority, not a list of model names we have to keep updating",
      "Reasoning models also cannot answer a 1-token request AT ALL (the old Test button sent one): it is a hard 400, not a short reply, because they spend tokens thinking before they write. They are now given room to think even for a connectivity ping",
      "The Deployment field is a dropdown of what is really deployed on your Azure resource, read live from Azure - no more typing a name that has to match exactly. It shows the model behind each deployment and flags any that are not healthy",
      "Verified end to end against the live resource: gpt-4o, gpt-4o-mini, gpt-5.4 and gpt-5.6-luna all pass Test and answer a real question",
      "Listing deployments never sends the stored key to a host you have not proved you hold the key for - the same rule the save path enforces",
    ],
  },
  {
    id: "feature-request-numbers-and-auto-hide",
    date: "2026-07-14",
    time: "09:15",
    title: "Feature requests get a ticket number, and implemented ones retire themselves after 7 days",
    items: [
      "Every feature request now has a number - #0000001, #0000002, and up - so you can quote one in a ticket or a chat instead of describing it. Existing requests were numbered oldest-first, so the numbers match the order they were actually filed",
      "Seven days after a request is marked Implemented it drops off the board on its own and lands in a collapsed Completed table at the bottom of the page. Nothing is deleted - it is still there, still numbered, just out of the way, so the board only shows what is still live",
      "Global and super admins get two controls: 'Hide now' retires an implemented or rejected request without waiting out the week, and 'Show 7 more days' pulls one back onto the board for another full week. That one can be clicked again each time the week runs out, so a request can be kept visible as long as it needs to be",
      "Reopening an implemented request (setting it back to Planned or Being scripted) cancels the timer and puts it straight back on the board",
      "A request being triaged now shows how long it has left - 'Hides in 5 days' - so nothing disappears as a surprise",
      "The hide is a deadline the page reads, not a background job that flips a flag. There is no cron in this app, and the heartbeat it fakes one with only ticks while a runner is beating - so a quiet fleet would have stalled the timer and left implemented requests on the board indefinitely. A deadline cannot stall",
    ],
  },
  {
    id: "spanning-portal-secret-split",
    date: "2026-07-14",
    time: "09:00",
    title: "Spanning: the console sign-in is now its own credential, and Test proves it by actually signing in",
    items: [
      "Spanning needs TWO credentials and they are not interchangeable: the API key (licensing, both onboard and offboard) and an M365 admin sign-in for the admin console (which is what force-sync drives in a browser). They now live in two separate Delinea secrets - 'spanning' and 'spanning-portal'",
      "The portal login is OPTIONAL. Licensing is pure API, so the clients that never force-sync need nothing and stay green - a client with no portal secret simply can't force a sync, and the step says so instead of failing",
      "Test on a client's Spanning system now signs in to the console for real - through Microsoft SSO and the MFA prompt - and triggers nothing. That catches a wrong password, an MFA method Delinea can't mint, Conditional Access blocking the runner, or an admin without console access BEFORE an onboarding needs it. It runs the same flow the force-sync uses, so it can't go green on a credential the real sync would choke on",
      "Only a targeted single-system Test does the real sign-in. Save-and-test, the whole-client run, the fleet button and the nightly sweep never do - one scripted M365 login per client per sweep is exactly the burst that risk-based Conditional Access starts challenging",
      "Set it up: on the spanning-portal secret put Username = an M365 admin's email, Password = that account's password, and enable One-Time Password so Delinea can supply the MFA code at the prompt. It must be a TOTP/authenticator-app method - push and phone-call MFA cannot be automated. See /help/spanning",
      "Guardrail: an M365 password put into the API secret's Username/Password would be sent to Spanning as clientId:clientSecret and 401 every licensing call. Delinea secrets named like 'Spanning Portal' are now filed into the portal slot rather than autofilled into the API slot",
      "Fixed alongside: a swept connection-test failure could go silently un-notified. The sweep marked its rows as swept AFTER creating them, so a row a runner claimed in that window stayed marked 'manual' - and only swept failures raise a notification. It's now set when the row is created",
    ],
  },
  {
    id: "spanning-force-sync-works",
    date: "2026-07-13",
    time: "23:00",
    title: "Spanning force-sync actually works now (runner 1.50.0)",
    items: [
      "The sync had never once completed - every attempt died at the Microsoft 'Stay signed in?' prompt, which left the browser parked on Microsoft's page so a perfectly good sign-in was reported as a failure. It is now answered",
      "The flow is driven end-to-end by a real test for the first time (against a stand-in Microsoft SSO portal on a separate origin): sign-in, minted MFA code, 'Stay signed in?', redirect, and the sync call itself",
      "It no longer tries to sign in with the Spanning API key - that can never authenticate against Microsoft and repeated attempts are how an account gets locked out. It now asks for a real portal login instead, and says so without ever echoing the value",
      "Still needed from you: put an M365 admin's email + password on the Spanning Delinea secret (PortalUsername/PortalPassword) and enable One-Time Password on it for the MFA prompt",
    ],
  },
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
