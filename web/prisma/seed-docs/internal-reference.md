# IAM Engine — Internal Reference

IAM Engine Internal reference: architecture, mechanics, and security implementation

INTERNAL: CORETELLIGENT STAFF ONLY. NOT FOR CLIENT DISTRIBUTION.

### About this document

This is the internal counterpart to the two client-facing IAM Engine documents (the client overview and the Setup and Configuration Guide). It covers the same architecture and mechanics in the same language we use with clients, plus the implementation and security detail we do not put in front of them: current deployment status, and the security roadmap items that are planned but not yet shipped.

When configuring a client, use the Setup and Configuration Guide for exact per-system permissions and steps; this document is not a duplicate of that material and does not repeat it in full.

## 1. What the platform does

Every organization has a runbook for bringing a person on and taking a person off. It names the systems, the groups, the licenses, the mailbox rules, the order things have to happen in, and the things that must never be done without a second pair of eyes. In most organizations that runbook lives in a document, and it gets executed by a person, by hand, under time pressure, usually across eight to twenty different consoles.

That is slow, and it is inconsistent, and it is where offboarding misses happen: a forgotten group membership, a mailbox that was never converted, a VPN account that stays live for six months, an MFA factor still registered to a phone that walked out of the building.

The IAM Engine takes that runbook and makes it executable. Your runbook becomes structured configuration: which systems you use, which groups a role gets, what happens on the way out, what requires approval. A central application reads that configuration, plans the work, and executes each step against the real system, in dependency order, checking state before it changes it, and recording everything.

### What you get

- Consistency. The same runbook executes the same way every time, whoever raises the ticket.

- Speed. A new hire's identity, mailbox, licenses, groups, and SaaS access are provisioned in minutes rather than across a day.

- Complete offboarding. Access is removed everywhere it was granted, including the places a human checklist tends to forget, and the evidence is captured before it is removed.

- An audit trail. Every action is recorded with the actor, the target, the result, and the evidence. Every step also writes a work note back to the originating ServiceNow ticket.

- Human control where it matters. Anything destructive is withheld from automation until a named, sufficiently senior person approves it.

### What it does not do

The engine is deliberately narrow. It does not replace your identity provider, your MDM, or your ticketing system. It drives them. It does not hold your secrets; a vault does. It does not make policy decisions; your runbook does. And it does not take irreversible action on its own.

## 2. How it works

There are three moving parts.

| Part | What it is | Where it lives |
| --- | --- | --- |
| The application | The brain. Holds the client configuration, plans each request into steps, queues those steps as jobs, brokers credentials, records results, and presents the UI. | Coretelligent-hosted |
| Runners | The hands. A PowerShell 7 service that picks up a job, executes it against the target system, and posts the result back. Same software everywhere; only its placement differs. | Coretelligent cloud and/or inside your network |
| The vault | Delinea Secret Server. Holds every credential. The application stores only a reference to a secret, never a secret value. | Coretelligent-managed vault |

### The lifecycle of a request

A request moves through six stages. A request is called a case; each system a case has to touch is a step.

| Stage | What happens |
| --- | --- |
| 1. Intake | A user-management ticket is raised in ServiceNow. The engine reads it, either by polling ServiceNow on a schedule or on demand, and creates a case. Cases are matched to the ticket number, so re-reading a ticket never creates a duplicate. |
| 2. Planning | The engine loads your profile: the systems you actually use, the groups that go with the person's role, what depends on what, and produces an ordered list of steps. Systems you do not use are not planned. Systems that only apply to certain roles are only planned when that role is matched. |
| 3. Hold | Nothing runs on import. A case sits held until an operator releases it, or until its scheduled time arrives. An offboard with a termination date is automatically scheduled to release five minutes after that instant. |
| 4. Dispatch | Each step becomes a job. Jobs are handed out only when their dependencies have succeeded, only to a runner capable of executing them, and, if the step is destructive, only after it has been approved. |
| 5. Execution | A runner claims the job, requests the one credential that job needs, connects to the target system, checks the current state, makes the change if it is needed, and reads the result back to confirm. |
| 6. Record | The result is posted back. The engine writes an audit entry, appends to the permanent run history, posts a work note to the ServiceNow ticket, and releases whatever steps were waiting on that one. When every step is done, the case closes. |

### Order is enforced, not assumed

Steps declare what they depend on, and the engine sorts them. For a client with on-premises Active Directory, the identity chain is fixed and cannot be misconfigured into a deadlock: Active Directory, then directory sync, then Entra ID, then Microsoft 365, then Exchange. Everything else hangs off that. Mailbox-dependent steps do not run before the mailbox exists. License-dependent steps do not run before the license is assigned.

### Every step is idempotent

Every executor checks state before it changes it. If a step is re-run after a partial failure, or run twice by accident, it converges on the same end state rather than creating a duplicate or a conflict. This is what makes it safe to retry, and it is the property that lets the engine recover automatically when a runner dies mid-job.

### Dry run

Any case can be run in dry-run mode. Every step connects for real, reads for real, and reports exactly what it would change, and writes nothing. This is the recommended first run for a newly configured client. Dry-run is enforced at the point a job is handed to a runner, so a case cannot be half-switched out of it.

### Verification, not assumption

A step reporting success is not the end. Before a case is allowed to complete, the engine re-runs each step's read-only validator and confirms the intended end state is actually present in the target system. For onboarding into a hybrid environment it also verifies the source anchor linking the AD account to the cloud account matches, which is what stops a rehire from silently becoming a second, duplicate identity.

## 3. The execution paths

Systems differ in where they can be reached from, and in whether they have an API worth using. The engine has four paths, and picks the right one per step. All four are visible on the case; nothing is silently skipped.

### Path A: cloud systems, executed centrally

Microsoft 365, Entra ID, Exchange Online, Google Workspace, Mimecast, Adobe, Zoom, Spanning, KnowBe4, Egnyte, SentinelOne, Duo, Jira, HubSpot, Salesforce, LogicMonitor, xMatters, Proofpoint, and 1Password are reachable over the public internet. A runner in Coretelligent's environment calls their APIs directly, authenticating as an application registration or API principal that you create and control.

Nothing is installed in your network for these systems. If you are a cloud-only organization, that is the entire footprint: some application registrations in your tenant, and nothing else.

### Path B: on-premises systems, executed by an agent in your network

Active Directory, directory sync, and hybrid Exchange cannot be reached from outside your network, and we do not ask you to make them reachable. Instead, a lightweight agent, the same runner software, is installed on a domain-joined Windows host inside your network.

The agent makes outbound connections only. It polls the application over HTTPS, asks whether there is work for it, does the work, and posts the result back. The platform never dials into your network. There is no listening port on the agent, and no inbound firewall rule is required. This is the same pattern as a ServiceNow MID Server.

What the agent needs:

- A domain-joined Windows host. A management or jump host is preferred; a domain controller works.

- PowerShell 7 and the RSAT Active Directory module. The installer will attempt to add RSAT itself, and will tell you plainly if it cannot.

- Outbound HTTPS to the application endpoint. Nothing else.

The agent installs as a Windows Scheduled Task running as SYSTEM, restarts on failure, and updates itself (see below). If you also want your Microsoft 365 work to run from inside your network rather than from Coretelligent’s cloud runner, that is a single configuration flag; all jobs for your organization will then be claimed by your own agent.

#### Redundancy across domain controllers

You can install more than one agent. Each is given a priority. The lower-priority agent stays dormant while a higher-priority peer is healthy, and takes over automatically when that peer stops reporting in. Two agents at equal priority share the load instead. No configuration change is needed at failover.

#### Self-update

Agents update themselves. The application publishes the current runner build; an agent that is behind pulls the changed files and restarts itself. An out-of-date agent is not given work; it is brought current first. Updates can be automatic (the default) or operator-triggered. You do not have to schedule maintenance windows for the agent, and we do not need remote access to your host to patch it.

### Path C: browser automation, as a last resort

A small number of systems have no API for the thing that needs doing. For those, and only those, the runner drives a headless browser through the vendor's own admin console, exactly as a person would.

- It runs inside the runner, on the same host that already has reach. It is an executor, not a transport.

- Passwords are passed to the browser process on standard input only. They are never written to a log, a command line, or a temporary file.

- Where the console requires a second factor, the one-time code is minted by the vault at the moment the prompt appears; the authenticator seed never leaves the vault. Push, SMS, and phone-call factors cannot be automated, and the flow stops cleanly rather than guessing.

- A browser step that fails is recorded as a warning with a screenshot, and does not fail the case.

Today exactly one browser flow ships: forcing a Spanning directory sync, because Spanning's API has no endpoint for it. We treat browser automation as a liability to be retired, not a strategy. Every one is replaced with an API call the moment the vendor offers one.

### Path D: manual steps, as first-class checklist items

Some things are not automatable and should not pretend to be: shipping a laptop, the welcome call, collecting returned equipment, a physical address-book update. These are planned into the case as checklist items. The case will not report itself complete while any of them is outstanding. An operator ticks them off, and can un-tick them. They are never silently skipped, and they are never quietly dropped from the plan.

### Capability-aware routing

Each runner reports what it is actually able to do: whether the Active Directory tooling loaded, whether the browser components are present. The application will not hand an Active Directory job to a runner that cannot execute one. The job waits, with a stated reason, rather than being dispatched to fail. That is the difference between "your onboarding is blocked because the agent is missing RSAT" and a red error at two in the morning.

## 4. The onboarding path

A typical onboarding plan for an organization with on-premises Active Directory synchronized to Microsoft 365. A cloud-only organization simply has no AD or sync links in the chain; the rest is the same.

| # | Step | What happens |
| --- | --- | --- |
| 1 | ServiceNow | The contact and task records are established against the case. |
| 2 | Active Directory | The user is created in the correct OU using your username convention. Display name, given name, manager, department, company, office, telephone, and proxy addresses are set. Home drive is mapped. Security groups are added, both the baseline set and the conditional ones your rules attach to the role, location, or department. |
| 3 | Directory sync | A delta sync cycle is triggered and confirmed, so the account appears in the cloud before anything tries to license it. |
| 4 | Entra ID / Microsoft 365 | The cloud account is confirmed, licensed (directly or via a licensing group), added to cloud groups, given aliases, and, where configured, issued a Temporary Access Pass so the user can register MFA on day one without a shared password. |
| 5 | Exchange | Mailbox is enabled and configured. On a hybrid tenant, the mailbox is enabled on-premises, because a cloud-side change would simply be overwritten by directory sync. |
| 6 | Write-back and consistency check | The assigned email address is written back into Active Directory, and the source anchor is verified to match the cloud object, so a rehire re-links to the existing identity rather than creating a duplicate. |
| 7 | SaaS estate | Mimecast, Adobe, Zoom, KnowBe4, Spanning, Egnyte, SharePoint, MDM enrollment, phone system, print management, and whatever else your profile lists, each with the groups, licenses, and product profiles your runbook specifies. |
| 8 | Manual items | Workstation build, welcome letter, first-day call: the checklist. |
| 9 | Case resolution | Credentials are delivered, MFA registration is confirmed, tasks are closed. This step always runs last. |

### Password and credential delivery

The initial password is generated at dispatch. It is shown to an operator exactly once, and is wiped at the moment it is revealed: two people opening the case cannot both see it, and the second is told plainly that it has already been revealed and cannot be recalled. The value is never written to the run log, the audit record, or the ServiceNow work note. The audit records that it was revealed, and by whom, never what it was.

Where your tenant supports it, we prefer to issue no password at all: a Temporary Access Pass lets the new starter register their own credentials and MFA directly, and nothing reusable ever transits a person.

## 5. The offboarding path

Offboarding is designed around one principle: contain first, destroy later, and never destroy without a human saying so. Access removal is immediate and reversible. Anything irreversible is gated.

| # | Step | What happens |
| --- | --- | --- |
| 1 | Capture evidence | Before anything is removed, the user's current state is captured and attached to the case: every group membership, every application assignment. If the termination is disputed, or the person is reinstated, the record of what they had is on the case. |
| 2 | Active Directory | Password is reset (and captured for the manager, where your runbook says so). All group memberships are removed. The user is hidden from the address book, the manager link is cleared, the account is disabled, and, unless your profile carries the do-not-move guardrail, the object is moved to the Disabled Users OU. |
| 3 | Entra ID | The account is confirmed disabled, cloud group memberships and enterprise-application assignments are removed, registered MFA factors are stripped, and active sessions are revoked. |
| 4 | Exchange | Mailbox is converted to shared, or forwarded, or given an out-of-office and a delegate, whatever your runbook specifies. Delegated access is granted to the named recipient. |
| 5 | Endpoint | Where SentinelOne is in scope, the departing user's registered devices are identified and disconnected from the network. Isolation is reversible; shutdown is not, and is gated. |
| 6 | SaaS estate | Access removed and seats reclaimed across the estate: Mimecast, Adobe, Zoom, Spanning, Duo, VPN, Jira, and the rest. License downticks happen after the mailbox conversion, not before. |
| 7 | Data custody | Drive and file ownership transfer, per your runbook. |
| 8 | Deferred archive | Where a grace period applies (typically 30 to 90 days), the archive or delete step is scheduled rather than executed. An immediate-termination flag collapses the grace period to now. |
| 9 | Equipment return | Checklist item. |

### Approval gates

Each step is classified by intent. Containment steps (disable, remove groups, revoke sessions) are reversible and run on the normal path. Destructive steps (deleting a mailbox, hard-deleting an identity, shutting down a device) are irreversible.

A step classified as destructive always requires approval and always captures evidence, and that cannot be switched off by configuration. The gate is enforced where the job is handed to a runner, not in the user interface, so an unapproved destructive job is never given to a runner at all, no matter what any screen does.

Approval is a separate permission held by senior roles. An engineer who runs the case cannot approve its destructive steps; that requires an operations manager or above. The approver's identity is recorded against the job automatically. It is not a free-text field.

### Guardrails

Client-specific hazards are encoded as guardrails in your profile rather than lived in someone's memory. Examples in production today:

- do-not-move-ou: for tenants where moving the AD object to a Disabled OU takes it out of sync scope and deletes the cloud user. The step disables in place instead.

- do-not-delete: the identity is disabled and retained, never removed.

- no-device-wipe-without-approval: endpoint destruction is always gated.

### Scheduled offboards

Where the ticket carries a real termination timestamp, the case is automatically scheduled to release five minutes after it. The engine deliberately refuses to auto-schedule, and holds the case for a human, when the date is ambiguous (a date with no time), already in the past (a backdated ticket must never fire an unwatched destructive run), or implausibly far out (a mis-keyed year). An offboard whose target identity could not be resolved with confidence never runs unattended.

## 6. Security

The engine holds the keys to your identity estate. The design starts from that premise, and the controls below are the ones that are actually implemented and in force, not aspirations. Where something is planned rather than shipped, it is called out at the end of this section.

### The central principle: the platform stores no secrets

Every credential lives in Delinea Secret Server. The application's own database contains a vault reference (an ID, and a label). It does not contain, and has no schema field capable of containing, a credential value. The client profiles are the same: they carry references, never values. This is enforced in the data model, not by convention.

#### How a credential reaches a runner

At the moment a runner needs to act, it asks the application for the one credential that job requires. Before releasing anything, the application checks, in order:

- The job exists, and this runner owns it. A runner cannot request a credential for a job assigned to a different runner.

- The runner is enabled.

- The job is actually in progress. Credentials are not brokered for pending, completed, or failed jobs.

- The requested secret is on that job's allowlist. Each job carries the specific secret names it is permitted to request. A runner cannot ask for an arbitrary secret; it can only ask for the ones its current job legitimately needs.

Only then is the value resolved from the vault and returned, with cache headers that forbid any intermediary from retaining it. The request is written to the audit log; the value is not.

The runner has no vault credentials of its own. It cannot talk to Delinea, and it does not know how to. It receives only what the application pushes down for the specific job in hand. This means an agent installed on your domain controller, the machine most exposed to your internal network, holds no standing access to any credential whatsoever. Compromising it does not yield the vault. It yields, at most, the credentials for jobs currently in flight on that host.

#### In memory only

The runner holds the credential in process memory for the lifetime of the job and no longer. It is never written to disk, never written into a profile, never cached, and never re-used for a subsequent job.

### Secrets never reach a log, a ticket, or an error message

Error text is the classic leak path: a stack trace containing a connection string, pasted into a ticket. Before any failure text leaves a runner, it passes through a scrubber that removes:

- The values of any field whose name suggests a secret (password, secret, key, token, credential, certificate, private, and so on).

- Any value carrying the structural characters of an encoded blob: slashes, plus signs, equals signs, braces, quotes, whitespace, regardless of what the field is called. A base64 string or a PEM block is never a hostname, so it is scrubbed on shape alone. This is what catches a secret that arrives in an unexpected field.

- Generated passwords injected by the application.

- The runner's own API token.

Usernames and server names are deliberately left visible, because a redacted error is useless for diagnosis. The scrubbed text is what is persisted to the run record, shown in the UI, and posted to the ServiceNow work note; all three read from the same scrubbed source.

There is a second, independent redaction boundary in front of the AI features used for runbook parsing: vault URLs, passwords, national identifiers, phone numbers, and email local parts are stripped before any text is sent to a language model. Secrets do not cross that boundary.

### Certificates

| Where | How |
| --- | --- |
| Exchange Online | App-only authentication is certificate-based by Microsoft's design; a client secret will not work. You hold the certificate: the public half goes on your app registration, the private half goes in the vault. At execution the private key is materialized only for the duration of the connection handshake and deleted in a guaranteed cleanup path. It is never left on disk, and never installed into a certificate store on a Coretelligent host. |
| Salesforce | The Connected App uses the JWT bearer flow; the runner signs an assertion with a private key held in the vault. No Salesforce password is ever stored. |
| Google Workspace | The service-account key signs a short-lived assertion. No password exists to steal. |
| Your own agent | If you run your own agent, the Exchange certificate can instead be installed into that host's Windows certificate store and referenced by thumbprint. The private key then never leaves your network at all. |

### Operator access to the application

Sign-in. Coretelligent staff sign in with Microsoft Entra SSO (OpenID Connect, authorization code flow with PKCE), against Coretelligent's own tenant. A local break-glass account exists for the case where SSO itself is the outage; its password is stored as a salted scrypt hash and verified in constant time, and its use is audited under its own distinct event.

Sessions are not bearer tokens and are not JWTs. A session is an opaque, high-entropy random value in an HTTP-only, same-site, secure cookie. The server stores only its SHA-256 hash, so a database disclosure yields nothing replayable. Sessions expire after 12 hours and can be revoked centrally and immediately.

Authorization is permission-based, across six roles. Permissions, not role names, are checked at every server-side entry point. The separations that matter:

- An engineer can plan and run cases, but cannot approve destructive steps.

- An auditor is strictly read-only.

- An importer can bring cases in but not execute them.

- Granting or removing the highest role is restricted to that role, so an administrator cannot promote themselves out of a control.

Per-client scoping is a server-side boundary, not a UI filter. Each operator's access to clients is either all, an explicit allowlist, or all-except-a-denylist; individual clients can additionally be marked restricted, requiring an explicit grant on top. This is enforced in the data queries themselves, and requests for a client outside an operator's scope return not found, not forbidden, so the existence of a client is not disclosed by probing. Hiding a client from a list is not a boundary if the API still answers a guessed URL; we treat it accordingly.

"View as" is read-only. A super-administrator can view the application as another user to reproduce an access problem. While doing so, every mutation is refused; it is a lens, not a login. Impersonation cannot be nested.

### How runners authenticate

Two credentials are involved, and they do different jobs.

| Credential | What it is | Lifetime |
| --- | --- | --- |
| Enrollment token | A short-lived, HMAC-signed token minted in the UI and bound to a specific scope and a specific client. It is self-describing: a token minted for your organization can only ever register an agent for your organization; it cannot be replayed to enroll an agent somewhere else. | One hour, by default |
| Runner API token | A bearer token the agent presents on every subsequent call. It is baked into the installer at generation time and written to the machine environment so the SYSTEM service can read it. | Until rotated |

The machine API is fail-closed. A request to any runner endpoint without a valid token is rejected. If the token is not configured at all, the endpoints return a service error rather than opening; a missing configuration cannot become an open door. The endpoints that carry credentials fail closed in every environment including development, because "no token configured" must never resolve to "serve tenant-administrator credentials to an unauthenticated caller."

The handful of endpoints that must be reachable without a token (the installer bootstrap, which a host with no token yet has to fetch) are an explicit allowlist, not a path prefix. That is a deliberate choice: it means a new credential-carrying endpoint added tomorrow is protected by default, rather than accidentally exposed because it happened to share a URL prefix.

Retrieving the runner token in the application is itself a privileged, audited action available only to senior administrators, and the audit records the retrieval, never the value.

### Network posture

The guarantee that matters: the agent inside your network makes outbound connections only. It polls the application, does work, and reports back. It exposes no listening port. The platform holds no route, no credential, and no mechanism to initiate a connection into your network. No inbound firewall rule is required, and none should be created. If you shut the agent down, we lose the ability to act; we do not retain a back door.

All communication with your SaaS systems, with the vault, and with Entra is over HTTPS. The runner contains no TLS-validation bypass; certificate validation is never disabled, anywhere in the codebase.

#### Current deployment state

Stated plainly: the platform is running as a pilot from a Coretelligent-hosted endpoint. Agents reaching it across the public internet do so over HTTPS. The production move to Azure Container Apps (a single stable HTTPS endpoint with a managed certificate, and platform secrets held in Azure Key Vault via managed identity) is the next scheduled piece of work, and is what every agent will poll once complete. We would rather set out where we are than imply a posture we have not yet finished building.

### Approvals, evidence, and audit

Approval is enforced at the dispatch gate. An unapproved destructive job is never handed to a runner. This is checked where the work is claimed, not in the interface, so the control cannot be bypassed by a UI defect, a direct API call, or a misconfigured screen. Approval requires a permission that the person running the case does not, by default, hold.

Evidence precedes removal. On the offboard path, group memberships and application assignments are captured and attached to the case before they are removed. The record of what someone had survives the removal of what they had.

The audit log is append-only, and it is comprehensive. Roughly 112 distinct action types are recorded, each with an actor, a timestamp, the client, the case, the job, and a structured detail payload: every sign-in, every failed sign-in, every credential brokerage, every approval, every agent enrollment, every secret re-wiring, every password reveal. Auditing is designed so that it cannot break the action it records, but the actions it records cannot escape it.

Alongside it, a permanent run history keeps one immutable row per job result. A job re-run overwrites the job's current state, but never the history; the record of the first attempt, and what it did, remains.

Write-back to ServiceNow. Every step posts a work note to the originating ticket, so the record of what was done lives where your service desk already looks. Work-note text passes through the same secret scrubber. The ticket number is pattern-validated before it is used in a query, which closes the injection path that a naively constructed ServiceNow query would otherwise open.

### What is planned, and not yet shipped

We would rather this be read from us than discovered later.

| Item | Status |
| --- | --- |
| Mutual TLS between agents and the application. Each agent would present a client certificate issued at enrollment, replacing the shared bearer token. | Planned. Today, agents authenticate with an enrollment token bound to the organization, plus a bearer token on the machine API. |
| Per-agent credentials. Today the bearer token is shared across the fleet rather than unique per agent. | Planned, alongside mutual TLS. The enrollment half (a token that can only ever register the agent it was minted for) is already in place. |
| Automated token rotation. Rotation today is a configuration change plus a re-run of the installer. | Planned. |
| Azure hosting with a managed TLS certificate and Key Vault-held platform secrets. | Planned; the next scheduled work item. |

## 7. Summary

The IAM Engine executes your onboarding and offboarding runbook, across your whole estate, the same way every time. Cloud systems are driven through APIs from Coretelligent's environment, using service principals you create and can revoke. On-premises systems are driven by a lightweight agent inside your network that makes outbound connections only and requires no inbound firewall change. Every step checks state before it changes it, verifies the result afterward, and records what it did.

No credential is stored in the platform. The vault holds them; the application holds references; a runner receives exactly one credential, for exactly one job, at the moment of execution, and holds it only in memory. Anything irreversible is withheld from automation until a named, senior human approves it, and the evidence of what someone had is captured before it is taken away.

For the client-facing narrative and the per-system setup guide, see the companion Coretelligent IAM Engine documents. Questions about anything in this reference should go to the IAM Engine engineering lead.
