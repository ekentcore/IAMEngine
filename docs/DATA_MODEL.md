# Data model

The Prisma schema (`web/prisma/schema.prisma`) is authoritative; this explains intent and
maps the ServiceNow intake forms to the `CaseRequest` payload.

## Entities

- Client — one row per client org. `backbone` (entra | google | ad-synced | ad-standalone),
  `status` (active | archived), pod, domains. Adding a client = create + seed its systems
  ("onboard a client"); archiving = set status archived ("offboard a client").
- SystemCatalog — the master list of systems we can act on (servicenow, m365, entra,
  exchange, active-directory, directory-sync, google-workspace, mimecast, proofpoint,
  adobe, zoom, slack, spanning, egnyte, knowbe4, sharepoint, mdm, dropbox, perimeter81,
  …). Holds the default mode, which lifecycle lanes it supports, the executing module
  name, and a build-priority tier so the UI can show "modeled vs not-yet-built."
- ClientSystem — the normalized profile: client × system, with `mode`, `onboardWhen` /
  `offboardWhen` (always | on-request | by-persona | never), `dependsOn`, `requiresApproval`,
  `captureEvidence`, and a free-form `config` JSON for the per-client bits (license
  bundles, group lists, OU paths, mailbox thresholds, transfer targets).
- Secret — per-client secret reference: `provider` (delinea) + `externalId` + label.
  Never a value. ClientSystem references secrets by name.
- Agent — a registered runner. `scope` (central | client-network), `clientId` (null for
  central), last-seen, version, status. Drives the agent-health view.
- CaseRequest — one onboarding/offboarding request. `action`, `serviceNowCaseNumber`,
  `status`, and `payload` JSON (the intake form, below).
- Job — one step of a case (one system). `sequence`, `mode`, `status`
  (pending | dispatched | running | succeeded | failed | manual | skipped),
  `assignedAgentId`, request/result/evidence JSON, timings, error. The unit runners poll.
- AuditLog — append-only trail; every state change and action lands here.

## Planning a case (orchestrator)

Given a CaseRequest, the orchestrator: loads the client's ClientSystems, drops any whose
lane is `never`, whose `on-request` condition isn't met by the payload, or whose
`by-persona` system isn't listed by the matched persona's bundle, then topologically
sorts by `dependsOn` (lane-specific deps win), and creates one Job per remaining system.
`api` jobs go to the queue for a runner; `manual`/`browser` jobs become case checklist
items (browser auto-runs if a capable runner exists, else manual).

## ServiceNow intake → CaseRequest.payload

Most clients' forms match these (the uploaded New User Request / Offboard User forms);
per-client deviations land in `otherNeeds` and are reconciled against the profile.

Onboarding payload fields: requestedBy, firstName, lastName, mi, personalEmail,
startDate, endDate, isRehire, listMembership, title, department, managerName,
officeLocation, personalPhone, timezone, homeAddress, mirrorPermissionsFromUser,
employmentType, roles[], hasDirectReports, cellPhoneRequired, emailAddressNeeded,
productLicenses[], fileShareAccess[], securityGroups[], needsComputer, computerOnsite,
monitors, monitorStands, otherHardware[], installedSoftware[], otherSoftware,
cloudApplications[], otherCloudApps, otherNeeds.

Offboarding payload fields: userToOffboard, notListedUser, dateOfOffboarding, timezone,
employeeAware, immediateTermination, collectCellPhone, deactivateCellPhone,
collectDeskPhone, maintainVoicemail, forwardPhoneVoicemail, oooMessage, collectComputer,
computerRemainsOnsite, provideMailboxAccessTo, allowedToMaintainEmail, otherNeeds.

Map of payload → behavior: e.g. `mirrorPermissionsFromUser` drives group/license copy;
`cellPhoneRequired` toggles the `teams`/telephony lane's on-request; `provideMailboxAccessTo`
sets the offboard mailbox-delegate target; `immediateTermination` collapses scheduled
grace-period steps (like the 30–90 day archive) to run now.
