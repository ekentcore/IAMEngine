# IAM Engine — Setup and Configuration Guide

IAM Engine Setup and Configuration Guide: exact permissions and steps, system by system

Companion to the IAM Engine client overview · Prepared for client IT and security teams

Version 3.0 · 24 July 2026. This edition replaces the dry-run verification stage with the staged read-only checks, documents how optional permissions and not-needed systems report on connection tests, and corrects the Egnyte credential. See the version history at the end.

### About this guide

This is the companion technical reference to the Coretelligent IAM Engine overview. Where that document explains what the platform does and why it is safe to grant it access, this guide gives your IT and security teams the exact screens, permissions, and artifacts needed to configure each system in scope.

Work through the systems you actually use. Anything you would rather handle by hand can be explicitly marked not needed in the setup wizard; it then shows up as a checklist item on the case, never as a failure.

## 1. What we need from you

This guide is the practical companion to the IAM Engine overview. For each system in scope we need a service principal you create in your own tenant, scoped to the minimum permissions the automation actually uses. You retain ownership of every one of them, and you can revoke any of them at any time, unilaterally, without our involvement.

### How credentials are handled, before we list them

- You create the credential in your system. You hold it.

- The credential value is placed in Delinea Secret Server. It is never emailed, never pasted into a ticket, and never stored in the application.

- The application database holds a reference (a vault secret ID) and nothing else. There is no field in the platform that can hold a secret value.

- At execution time, the application resolves that one secret and pushes it down to the one runner executing the one job that needs it. See the Security section for the full mechanism.

### The setup wizard

Configuration is not a spreadsheet exchange. Each system has a guided setup page in the application that walks through the vendor's own console, names the exact screens and the exact permissions, and then verifies the result in four stages:

| Stage | What it proves |
| --- | --- |
| Wired | A vault reference exists for this system. |
| Field check | The secret actually carries the fields this connector reads, before we try to use it. |
| Connection test | A runner resolved the secret, connected to the live system, and performed one cheap authorized read. |
| Rights probe | Each individual operation the automation will perform is probed and reported: create a user, add to a group, read licenses. An optional capability you chose not to grant is reported as optional, never as a failure. Where a vendor exposes no way to introspect permissions, we say so rather than guess. |

(Earlier editions listed a fifth stage, a read-only dry run of the whole case. That mode is retired: the simulation switch it relied on suppresses the target system's real responses, so its report could disagree with a live run. The four stages above are all genuinely read-only against the live system.)

A system that you handle by hand can be explicitly marked not needed. It is then shown as a checklist item, never as a failure, and on the connection-test panel it appears as a read-only N/A row with no retest button rather than as an error.

### Automatic and manual setup

Each system can be set up in one of two ways, and you choose per system.

- Manual. You create the credential in the vendor's console yourself, following the exact screens in the sections below, and record its vault reference. This path exists for every system and is always available.

- Automatic. For the systems that support it, the application creates the credential for you. Microsoft 365 and Google Workspace are provisioned through the vendor's API from a single administrator sign-in (see those sections). Adobe, Zoom, Egnyte, KnowBe4, Spanning, and Mimecast are provisioned by driving the vendor's admin console in a headless browser: you sign in once, and the runner creates the API application or token and vaults it. The automatic path uses the same safeguards as any browser step — the password reaches the browser on standard input only, a second factor is minted from the vault when the console asks for it, and push, SMS, and phone-call factors cannot be automated. An account that signs in only through SSO cannot be driven this way; use the manual path for it.

Whichever path is used, the application records which credential and vault folder performed the setup, so the provenance of every connector is on the record and you know exactly what to revisit if a permission later needs changing.

### Microsoft 365 and Entra ID

This is the one that matters most, and the one with the most nuance.

You can set this up automatically. "Set up Microsoft 365 automatically" in the application creates the application registration described below, adds and admin-consents the Graph and Exchange permissions (including the optional ones you choose to grant), generates the client secret and the Exchange certificate, and vaults the finished credential, all from a single device-code sign-in with a Global Administrator. The rest of this section is what that automation configures, and the reference for doing it, or auditing it, by hand.

#### You create: an Entra application registration

- Single tenant. No redirect URI. It is an unattended service principal, not a sign-in app.

- A client secret (24-month expiry). We surface its expiry date in the UI and warn you before it lapses.

- The Directory (tenant) ID.

A Global Administrator user account cannot be used, and never will be able to be. Entra rejects a user account in the client-credentials flow. It fails with AADSTS700016 ("no application with that app id exists in this tenant") because the app ID it is being handed is a person, not an application. This is not a configuration we can work around; it is how the protocol works. The platform actively detects this and refuses to accept a user account in an application-registration slot.

#### Microsoft Graph: application permissions, admin-consented

| Permission | Why | Required? |
| --- | --- | --- |
| User.ReadWrite.All | Create and update users; assign licenses. | Yes |
| Group.ReadWrite.All | Add and remove group memberships. (GroupMember.ReadWrite.All is sufficient if you prefer it.) | Yes |
| Organization.Read.All | Read license and seat counts, so we can warn before a case fails for want of a seat. | Yes |
| Domain.Read.All | Read verified email domains. Required for tenants with more than one. | Yes |
| UserAuthenticationMethod.ReadWrite.All | Offboarding: strip the leaver's registered MFA factors (phone, Authenticator, FIDO2). Without it, a departed user's registered factors remain, and the engine raises a warning rather than failing. Also required to issue a Temporary Access Pass on onboarding, which fails outright without it. | Strongly recommended |
| User-PasswordProfile.ReadWrite.All | Reset an existing user's password. Graph gates changing a password behind this specific role: User.ReadWrite.All covers setting one while *creating* an account, but not changing it afterwards. Without it, "Generate random password" fails with "Insufficient privileges" while the rest of the case succeeds. | If we reset passwords for you |
| Directory.Read.All | Resolve managers by name. Also satisfies Domain.Read.All and Application.Read.All below, if you would rather grant one broader role than three narrow ones. | If you set managers |
| Application.Read.All | Lets the app read its own credential expiry, so we can warn you before your client secret lapses. | Optional |
| Mail.Send | Send the onboarding/offboarding notification email, as the mailbox you nominate. Without it, a configured notification silently never arrives. | If you want notifications |
| Device.ReadWrite.All | Offboarding: disable the leaver's Entra-joined devices. Without it, their device objects stay enabled and the engine raises a warning. | If we disable devices |
| Exchange.ManageAsApp | Exchange Online administration. Office 365 Exchange Online API, not Graph. Note this one is not sufficient on its own: the app's service principal must also hold the **Exchange Administrator** directory role, and Exchange Online app-only authenticates with a certificate rather than the client secret. | Only if Exchange is in scope |

Required versus optional is honored in what you see: a connection test reports a missing optional capability as "+N optional", never as a red failure, so a deliberately narrow grant does not read as a broken one.

By design, the application registration is not granted permission to grant itself permissions. It holds neither Application.ReadWrite.All nor AppRoleAssignment.ReadWrite.All. Adding a Graph permission is always a deliberate act by one of your administrators. This is a constraint we impose on ourselves.

#### Exchange Online: certificate, not secret

Exchange Online's app-only authentication does not accept a client secret. It requires a certificate.

- You upload the public certificate (.cer) to the same app registration. A self-signed certificate is fine.

- The private key (.pfx) goes into the vault, base64-encoded, with its password, and never onto disk in the application.

- The app registration's service principal must additionally be assigned the Exchange Administrator directory role, and it must be active, not PIM-eligible. The Exchange.ManageAsApp permission alone is not sufficient. This catches people out.

At execution, the runner writes the private key to a randomly named temporary file only for as long as the Exchange connection is being established, and deletes it in a guaranteed cleanup block. It is never committed to a certificate store on a Coretelligent host, and never persisted.

If you run your own agent, you can instead install the certificate into that host's Windows certificate store and reference it by thumbprint. The private key then never leaves your network at all.

#### Temporary Access Pass

If you want new starters to self-register credentials and MFA rather than receive a password, enable Temporary Access Pass in Entra, under Protection then Authentication methods, and target it at the relevant users. This uses the same application registration.

### Active Directory (and hybrid Exchange)

Required only if you have on-premises AD. Executed by an agent in your network. See Path B under execution paths.

#### You provide: a host

- A domain-joined Windows host with PowerShell 7 and the RSAT Active Directory module. Outbound HTTPS only; no inbound rules.

#### You provide: AD rights (optionally, a service account)

The agent can run under an account that already holds the necessary rights, in which case no AD credential is stored at all, and it simply uses the ambient domain context. If you prefer a dedicated service account, it needs:

- Create user objects delegated on the target OU(s). This is genuinely probed. We read the OU's security descriptor and tell you, by name, if no access control entry grants the account that right, rather than letting you discover it on the first live onboard.

- Modify, disable, and move rights on those OUs, for the offboard path.

The connection test authenticates exactly the way a real job does: an agent running on a domain controller with ambient rights passes it — with a live directory read as proof — holding no stored credential at all. A wired AD credential is only ever used as a best-effort fallback for an agent on a member server that genuinely needs one.

#### Directory sync

The sync cmdlets exist only on the Entra Connect server, which is frequently not a domain controller. Name that host in your profile and the agent will remote into it using the same AD credential; that account must be permitted to run a sync cycle there.

#### Hybrid Exchange

If you run hybrid Exchange, mailbox enablement and conversion must happen on-premises. A cloud-side change is simply overwritten by the next directory sync. We need an AD account with Exchange Recipient Management rights (frequently the same account as above) and your Exchange PowerShell endpoint URI. Note that this must be the internal FQDN the service principal name actually matches, not your public mail domain. A mismatch here is the single most common hybrid setup failure we see.

A note on OU paths. "The server is unwilling to process the request" on user creation is, in our experience, almost never a permissions problem; it is a wrong distinguished name. The two causes are a domain mismatch (the OU path was built from the email domain rather than the AD domain; your AD may be corp.example.com while your mail is example.com) and OU name spacing. The engine now derives distinguished names from the domain itself rather than from the email domain, which eliminates the first class entirely.

### Google Workspace

This too can be set up automatically. "Set up Google Workspace automatically" creates the service account, grants it domain-wide delegation for the scopes below, and vaults the key. If the delegation grant cannot be confirmed automatically, the setup page gives you the client ID and the exact scopes to paste into the Admin console, then re-verifies. To do it entirely by hand, create the artifacts and authorize the scopes below. On a locked-down machine that cannot run command-line tools, the Google key converter (under More, then Tools) turns a downloaded service-account JSON key into the exact vault fields in the browser, with nothing installed.

You provide two artifacts:

- A Google Cloud service account with a downloaded JSON key, in a project with the Admin SDK API enabled. No project IAM roles are needed.

- A domain-wide delegation authorization for that service account's client ID, added in the Admin console under Security, then Access and data control, then API controls, then Manage Domain-Wide Delegation.

- A super-administrator email address for the service account to impersonate.

The exact OAuth scopes to authorize:

| Scope | Why |
| --- | --- |
| admin.directory.user | Create, update, and suspend users. |
| admin.directory.group | Group membership. |
| admin.directory.orgunit | Place users in the correct organizational unit. |
| admin.directory.user.security | Offboarding: sign the leaver out everywhere. This one matters: suspending an account blocks new sign-ins but does not invalidate tokens already issued, so without this scope a departing user's phone keeps syncing mail. |

Google's delegation is all-or-nothing per token request, which has a pleasant consequence: if the connection test passes, every requested scope is provably granted. There is no partial state to discover later. Onboarding will refuse to place a user in the root OU; offboarding suspends and moves to an inactive OU, and never deletes.

### The rest of the estate

Each of these is set up once, and only if you use it. The application's setup guide for each names the exact console screens. Six of them — Adobe, Zoom, Egnyte, KnowBe4, Spanning, and Mimecast — additionally offer an "Automatic (browser)" option that creates and vaults the credential from a single administrator sign-in, as described under Automatic and manual setup above; the columns below are what that automation produces, and the reference for creating it by hand.

| System | Auth method | What you create and hand over |
| --- | --- | --- |
| Mimecast | API 2.0 app, OAuth2 client credentials | An API 2.0 application (Integrations, then API and Platform Integrations). Role: Basic Administrator or Help Desk Administrator, with four products enabled: Account Management, Domain Management, Directory (Sync) Management, and User and Group Management. Client ID and Client Secret. |
| Proofpoint Essentials | Admin email and password (admin-only API) | A dedicated automation admin login, your pod/region, and your org domain. Note: Proofpoint provisions by directory sync, not by API. This step verifies the user synced in and retries until it does. It does not create. |
| Spanning Backup | HTTP Basic: login email and API key | Your Spanning admin login email and a generated API Token, plus your region. If you also want the force-sync browser flow, the same vault entry additionally needs an M365 admin portal login with a TOTP/app second factor; push and SMS factors cannot be automated. |
| Adobe | OAuth Server-to-Server (UMAPI v2) | Adobe Developer Console, new project, User Management API, OAuth Server-to-Server. Client ID, Client Secret, and your Organization ID (...@AdobeOrg). Also the exact product profile names; a typo silently grants nothing. |
| Zoom | Server-to-Server OAuth app | Marketplace, Develop, Build App, Server-to-Server OAuth. Account ID, Client ID, Client Secret. Six user scopes; eight more only if you provision Zoom Phone. Turn off the "new experience" toggle on the build page; with it on, admin calls fail. |
| SentinelOne | API token (service user) | Settings, Users, Service Users, Create. A service user (not a personal login) with a role that can disconnect and shut down agents. Its API token, plus your management console URL. Offboard-only. |
| Duo | Admin API, HMAC-signed | Applications, Protect an Application, Admin API, with both "Grant read resources" and "Grant write resources." Integration key, secret key, API hostname. Offboard-only. |
| KnowBe4 | SCIM 2.0 bearer token | SAML SSO must be configured first; KnowBe4's REST API is read-only and cannot create users. Account Settings, User Management, SCIM, generate a SCIM bearer token. If you already provision KnowBe4 from Entra SCIM, you do not need this at all. |
| Egnyte | OAuth2 password grant (four fields) | An API key (the Client ID) and Client Secret for an app on your tenant, plus a dedicated admin login email and that account's password; the runner mints a short-lived bearer token from the four. The Egnyte domain is optional and derived from the login email. A pre-minted long-lived token also works in place of the four fields (it is what the automatic browser setup harvests). |
| Jira / Atlassian | HTTP Basic: admin email and API token | An organization or user-access admin, their API token, and your site URL. Note each product granted consumes a paid seat. |
| Salesforce | Connected App, OAuth 2.0 JWT bearer | App Manager, New Connected App, Enable OAuth, Use digital signatures, with a certificate you upload. Scopes: api, and refresh_token/offline_access. Permitted Users = "Admin approved users are pre-authorized." Consumer key, integration user, private key. No password is stored. |
| HubSpot | Private app access token | A Super Admin creates Settings, Integrations, Private Apps, with settings.users.read and settings.users.write. The access token. |
| LogicMonitor | LMv1 token (HMAC-signed) | A service user with a role that can manage users; Manage, API Tokens, Add. Access ID and Access Key, and your portal subdomain. Offboard-only. |
| xMatters | HTTP Basic: API key and secret | An account with the REST Web Service User role. Developer, API Keys, Create. Key and secret (the secret is shown once), plus your company URL. |
| Perimeter 81 / Harmony SASE | API key as bearer | An API key from Settings, API. Access is usually group-driven, so this is typically an on-request step. |
| 1Password | SCIM (preferred) or CLI | 1Password has no application-only API for user management. Preferred: provision from your IdP via the SCIM bridge; then nothing is handed over at all, and the engine simply manages the group. The CLI path requires an owner/admin account exempt from MFA and is not recommended. |

### Not yet built

These appear in the catalog but have no executor today and are planned as manual checklist steps until they do: SharePoint, Slack, Teams and Teams Phone, Dropbox, Notion, Printix, Azure Virtual Desktop, MDM (Intune/Jamf/Addigy), bulk data transfer, and mailbox archive. We would rather tell you this than have you discover it. (Slack's API credential can already be captured through the automatic browser setup, ahead of its provisioning executor being built.)

### Credential rotation

Your Entra client secret and your Exchange certificate both expire. The engine reads their expiry from the vault and from the tenant itself, surfaces it on the client's health view, and raises a notification before it lapses, so rotation is a scheduled task rather than an outage.

## 2. Summary

The IAM Engine executes your onboarding and offboarding runbook, across your whole estate, the same way every time. Cloud systems are driven through APIs from Coretelligent's environment, using service principals you create and can revoke. On-premises systems are driven by a lightweight agent inside your network that makes outbound connections only and requires no inbound firewall change. Every step checks state before it changes it, verifies the result afterward, and records what it did.

No credential is stored in the platform. The vault holds them; the application holds references; a runner receives exactly one credential, for exactly one job, at the moment of execution, and holds it only in memory. Anything irreversible is withheld from automation until a named, senior human approves it, and the evidence of what someone had is captured before it is taken away.

For the narrative version of this material (what the platform does, how it works, and why it is safe to grant this access), see the companion Coretelligent IAM Engine overview document. Questions should go to your Coretelligent engagement contact.

## 3. Version history

| Version | Date | What changed |
| --- | --- | --- |
| 3.0 | 24 July 2026 | Removed the dry-run verification stage — the mode is retired, and the four staged read-only checks are the verification. Documented optional-permission reporting ("+N optional", never a failure), not-needed systems as read-only N/A rows on connection tests, and the ambient-identity Active Directory connection test (an agent on a domain controller passes with no stored credential). Corrected the Egnyte credential to the Client ID + Client Secret + admin-login password grant, with a pre-minted token as the alternative. |
| 2.0 | 22 July 2026 | Added automatic setup: Microsoft 365 and Google Workspace can now be provisioned end to end from a single administrator sign-in, and Adobe, Zoom, Egnyte, KnowBe4, Spanning, and Mimecast gained an automatic browser-driven credential setup alongside the manual steps, which are unchanged. Documented the Google key converter for locked-down machines, and the setup-provenance record kept for every connector. |
| 1.0 | 14 July 2026 | Initial version. |
