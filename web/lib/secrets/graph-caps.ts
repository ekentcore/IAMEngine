// What the m365-admin app registration must be able to DO in Graph, expressed as capabilities rather
// than a flat permission list.
//
// A capability is satisfied by ANY of its `anyOf` app roles — Microsoft offers several ways to grant
// the same power (User.ReadWrite.All or Directory.ReadWrite.All both let us create a user), so a flat
// "you must have exactly these six" list produces false failures on a tenant that granted a broader
// role. Naming the capability also means a gap reads as "can't add users to groups" instead of a bare
// "Insufficient privileges".
//
// This mirrors $GRAPH_REQUIRED_CAPS / $GRAPH_OPTIONAL_CAPS in runner/Start-IamRunner.ps1, which is
// the executor's copy. The runner cannot import TypeScript and the app cannot import PowerShell, so
// the two are kept in sync by hand; graph-caps.test.ts pins the role names so a drift shows up as a
// failing test rather than a fleet-wide false "permission missing".
export type GraphCap = {
  need: string; // what breaks without it, in an engineer's words
  anyOf: string[]; // any ONE of these app roles satisfies it
  why?: string; // optional: the consequence of not granting it (optional caps only)
};

export const GRAPH_REQUIRED_CAPS: readonly GraphCap[] = [
  { need: "create / update users + assign licenses", anyOf: ["User.ReadWrite.All", "Directory.ReadWrite.All"] },
  { need: "add users to groups", anyOf: ["Group.ReadWrite.All", "GroupMember.ReadWrite.All", "Directory.ReadWrite.All"] },
  {
    need: "read licenses / groups (SKUs)",
    anyOf: ["Organization.Read.All", "Directory.Read.All", "Directory.ReadWrite.All", "User.Read.All", "Group.Read.All"],
  },
];

// OPTIONAL: reported so a gap is VISIBLE, but a miss NEVER fails a test. Each degrades gracefully —
// the feature that needs it warns and carries on. Matches the client-facing consent list in
// web/app/help/cloud-auth.
export const GRAPH_OPTIONAL_CAPS: readonly GraphCap[] = [
  {
    // Also covers ISSUING a Temporary Access Pass on onboard (Invoke-CtgEntraTap) — same app role,
    // opposite lane. Worth naming: the offboard half degrades to a warning, but a client whose onboard
    // hands out a TAP has that step FAIL without this.
    // NOT here: revoking sign-in sessions. Microsoft's docs say app-only revoke needs
    // User.RevokeSessions.All with "no higher privileged permission available", but that is stale —
    // 12 production offboards revoked sessions with User.ReadWrite.All and zero warnings. Adding a cap
    // for it would invent a false "missing" for something that demonstrably works.
    need: "remove MFA methods on offboard, and issue a Temporary Access Pass on onboard",
    anyOf: ["UserAuthenticationMethod.ReadWrite.All"],
    why: "without it a leaver's registered second factors (phone / Authenticator / FIDO2) stay on the account and go live again the moment it is re-enabled; offboard warns and continues. A TAP-issuing onboard fails outright",
  },
  {
    // Directory.Read.All and the Domain write roles are HIGHER-privileged alternatives that Microsoft
    // documents for GET /domains, and they were missing here: a tenant with Directory.Read.All (which
    // several have) reads domains fine and was still told to grant Domain.Read.All. Verified against a
    // live tenant — core1390 has Directory.Read.All, no Domain.Read.All, and GET /domains returns 200.
    // This is the exact false-"missing" the anyOf design exists to prevent.
    need: "read the tenant's verified email domains (multi-domain clients)",
    anyOf: ["Domain.Read.All", "Domain.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"],
    why: "needed only when a client has more than one verified email domain, to pick the right one; single-domain clients are unaffected",
  },
  {
    need: "read whether a leaver's mailbox was converted to shared",
    anyOf: ["MailboxSettings.Read", "MailboxSettings.ReadWrite"],
    why: "without it the leaked-seat scan can still see that a disabled user is still licensed, but cannot say whether their mailbox was converted to shared — so it can't tell you whether the licence is safe to remove yet",
  },
  {
    // Graph treats passwordProfile as a PRIVILEGED write with its own app role: User.ReadWrite.All
    // sets a password as part of CREATING a user (New-MgUser, psm1:697) but is denied when CHANGING
    // one afterwards (Update-MgUser, psm1:1892). That split is why onboarding looks healthy while a
    // reset fails on the same credential — only the reset issues a passwordProfile UPDATE.
    //
    // Adopting is how you MEET this, not a cause of it: the adopt branch (psm1:664) only stamps the
    // provisioning marker and never touches the password, so the new hire's account keeps whatever
    // password it already had and the operator follows up with "Generate random password" — which is
    // the call that gets denied. UM0028954 is exactly that sequence.
    need: "reset a cloud user's password (the 'Generate random password' action)",
    anyOf: ["User-PasswordProfile.ReadWrite.All"],
    why: "without it Graph denies the reset outright with 'Authorization_RequestDenied'. Unlike the other optional caps this one does NOT degrade — the step fails. It is optional only because a client who never resets a cloud password is unaffected; an onboard that CREATES the account sets its password as part of the create and is not affected",
  },
  {
    // Get-CtgAppCredentialExpiry reads THIS app's own passwordCredentials/keyCredentials so the conn
    // test can warn before the secret expires and every step starts failing at once. It already
    // degrades to a note, but nothing modelled it, so "why is there no expiry warning?" had no answer.
    // Directory.Read.All covers it as a higher-privileged alternative — verified live against
    // core1390, which has no Application.Read.All and still reads /applications 200.
    need: "warn before this app registration's own secret/certificate expires",
    anyOf: ["Application.Read.All", "Application.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"],
    why: "without it the connection test cannot read the credential's expiry date, so it can't warn you in advance — the first sign is every M365 step failing at once on the day it lapses",
  },
  {
    // Send-CtgGraphMail (Coretelligent.Notify) POSTs /users/{from}/sendMail. Same shape of miss as the
    // password reset: the feature shipped, nothing ever asked for the role, and no tenant in the fleet
    // has it. Only bites the clients that configure a notification, which today is one.
    need: "send an offboard notification email as a mailbox",
    anyOf: ["Mail.Send"],
    why: "without it any configured onboard/offboard notification fails to send — the case still completes, so the mail simply never arrives. Only clients with a notification configured are affected",
  },
  {
    // Update-MgDevice -AccountEnabled:$false on offboard (disableDevices). Note the READ side
    // (Get-MgUserRegisteredDevice) is NOT the issue: Microsoft's docs claim app-only is "not supported"
    // there, but it returns 200 for tenants holding only Directory.Read.All — verified on core1390 and
    // coretelligent. It is the WRITE that needs a device role.
    need: "disable a leaver's Entra-joined devices",
    anyOf: ["Device.ReadWrite.All", "Directory.ReadWrite.All"],
    why: "without it the leaver's Entra device objects stay enabled; the offboard warns and continues. Only clients with disableDevices configured are affected",
  },
  {
    need: "grant a delegate access to a leaver's OneDrive on offboard",
    anyOf: ["Files.ReadWrite.All", "Sites.ReadWrite.All"],
    why: "without it the offboard OneDrive delegate hand-off fails with a permission error; the step warns and continues",
  },
];

// The Entra portal needs an app-role ID, not a name, to grant a permission non-interactively. Only
// the ids we hand out in add-instructions live here; a name with no id still gets portal steps.
//
// These MUST be APPLICATION role ids (servicePrincipal.appRoles), not delegated scope ids
// (oauth2PermissionScopes). Microsoft publishes both under the same NAME with different ids, and a
// delegated id grants nothing to an app-only credential — it is accepted, consented, and useless.
// Every id below was read back from the Graph service principal itself
// (appId 00000003-0000-0000-c000-000000000000), which is the only authoritative source; the
// docs and third-party permission sites list the delegated id alongside the app one.
export const GRAPH_APP_ROLE_IDS: Readonly<Record<string, string>> = {
  "UserAuthenticationMethod.ReadWrite.All": "50483e42-d915-4231-9639-7fdb7fd190e5",
  // Was 7e05723c-0bb0-42da-be95-ae9f08a6e53c — that is the app role for Domain.ReadWrite.All, so the
  // grant instructions asked admins for tenant domain WRITE to satisfy a read-only capability.
  "Domain.Read.All": "dbb9058a-0e50-45d7-ae91-66909b5d4664",
  "MailboxSettings.Read": "40f97065-369a-49f4-947c-6a255697ae91",
  "User-PasswordProfile.ReadWrite.All": "cc117bb9-00cf-4eb8-b580-ea2a878fe8f7",
  "Application.Read.All": "9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30",
  "Mail.Send": "b633e1c5-b582-4048-a93e-9f11b44c7e96",
  "Device.ReadWrite.All": "1138cb37-bd11-4084-a2b7-9f71582aeddb",
  "Files.ReadWrite.All": "75359482-378d-4052-8f01-80520e7db3cd",
};

// The Microsoft Graph resource app id — the service principal that owns all of the roles above.
export const GRAPH_RESOURCE_APP_ID = "00000003-0000-0000-c000-000000000000";

export type CapRow = { need: string; anyOf: string[]; ok: boolean; optional: boolean; why?: string };

// Exported so callers that need the same anyOf-satisfaction logic against a bare `{ anyOf }` shape
// (provision-m365-app.ts's admin-consent + optionalGaps checks) don't have to re-implement it.
export function satisfied(cap: GraphCap, granted: readonly string[]): boolean {
  const have = new Set(granted.map((g) => g.toLowerCase()));
  return cap.anyOf.some((r) => have.has(r.toLowerCase()));
}

// REQUIRED capabilities the granted roles do NOT cover. Optional caps are deliberately absent: this
// drives failure, and an optional miss must never fail.
export function graphCapGaps(granted: readonly string[]): GraphCap[] {
  return GRAPH_REQUIRED_CAPS.filter((c) => !satisfied(c, granted));
}

// Every capability, required and optional, with its verdict — for reporting.
export function graphCapRows(granted: readonly string[]): CapRow[] {
  return [
    ...GRAPH_REQUIRED_CAPS.map((c) => ({ need: c.need, anyOf: [...c.anyOf], ok: satisfied(c, granted), optional: false, why: c.why })),
    ...GRAPH_OPTIONAL_CAPS.map((c) => ({ need: c.need, anyOf: [...c.anyOf], ok: satisfied(c, granted), optional: true, why: c.why })),
  ];
}

// The single role to ask for when a capability is missing: its first `anyOf`, which is the narrowest
// one that satisfies it (the lists are ordered least-privilege first — never suggest
// Directory.ReadWrite.All when User.ReadWrite.All will do).
export function suggestedRole(cap: GraphCap): string {
  return cap.anyOf[0];
}

// ── Over-permissioning ───────────────────────────────────────────────────────────────────────────
//
// The capability table answers "can this credential do the job?". It says nothing about the opposite
// failure, which is the one that matters to a client's security team: authority we were handed and
// never asked for. Nothing looked at that, so nobody knew — and /help/cloud-auth states as a design
// promise that the app "cannot grant itself new permissions (that would need Application.ReadWrite.All
// + AppRoleAssignment.ReadWrite.All, which we deliberately do not hold)". Across the fleet, five
// credentials hold the first and two hold both. The promise is real; the grants drifted from it.
//
// Roles that let a credential EXPAND ITS OWN AUTHORITY, or reach the whole tenant's content. None is
// ever needed by this engine — every one is a standing "escalate to whatever you like" primitive on a
// secret that a runner reads at execution time.
export const GRAPH_ESCALATION_ROLES: Readonly<Record<string, string>> = {
  "RoleManagement.ReadWrite.Directory":
    "can assign directory roles — including making itself Global Administrator. This single role is a route to full tenant takeover",
  "AppRoleAssignment.ReadWrite.All":
    "can consent app roles to itself — whatever it is missing, it can grant. It makes every other permission boundary advisory",
  "Application.ReadWrite.All":
    "can add credentials to ANY app registration in the tenant, and so authenticate as any of them",
  "DelegatedPermissionGrant.ReadWrite.All":
    "can grant delegated permissions on users' behalf, without those users consenting",
  full_access_as_app: "full access to EVERY mailbox in the tenant — the engine only ever needs the mailboxes in a case",
  "Sites.FullControl.All": "full control of every SharePoint site in the tenant",
};

// Roles on OTHER resources (not Graph) that the engine genuinely uses, so the surplus check does not
// report them as unused. Exchange Online app-only auth needs Exchange.ManageAsApp — see
// Connect-CtgExchange.
//
// Sites.FullControl.All is deliberately NOT listed here. The Office 365 SharePoint Online app role of
// that name is what the offboard PnP site-collection-admin hand-off needs (Graph cannot make a user a
// site-collection admin), and it IS genuinely used by clients who wire up that hand-off — but the caps
// model matches granted roles by NAME only, with no notion of which API resource (Graph vs SharePoint
// Online) issued the grant. Microsoft Graph also exposes an app role named literally
// "Sites.FullControl.All" that grants full control of every SharePoint site in the tenant via Graph —
// a genuine escalation, unrelated to the narrower SharePoint-resource grant the offboard hand-off asks
// for. Reclassifying this as a "used" role (as a prior change here did) makes the surplus scan blind to
// that Graph-resource escalation on any tenant where it is actually present, because the model cannot
// tell the two apart. Keeping it in GRAPH_ESCALATION_ROLES is the safe default: clients using the
// SharePoint hand-off will see it flagged as extra-access/escalation (a known false positive, documented
// in web/app/help/cloud-auth) — verify against the offboard result rather than "fixing" this again by
// removing it from escalation.
const USED_NON_GRAPH_ROLES: readonly string[] = ["Exchange.ManageAsApp"];

export type SurplusRole = {
  role: string;
  escalation: boolean; // true = grants authority beyond anything the engine does; report loudly
  why: string;
};

// Which granted roles is this credential holding that the engine does not need?
//
// "Need" is computed per capability as the FIRST granted role in its anyOf — the least-privileged one
// present. Everything else is surplus, which splits two ways:
//   - redundant: satisfies a capability, but a narrower granted role already covers it
//     (User.ReadWrite.All + Directory.ReadWrite.All → the broad one is surplus, not the narrow one)
//   - unused:    satisfies no capability we model at all
// An escalation role is always reported, even in the odd case where it also satisfies something.
//
// ADVISORY, never a failure: the m365-admin app registration may be shared with tooling that is none
// of our business, so this says "the engine does not use this", never "remove it".
export function graphSurplusRoles(granted: readonly string[]): SurplusRole[] {
  const have = new Set(granted.map((g) => g.toLowerCase()));
  // The least-privileged granted role satisfying each capability — the ones worth keeping.
  const needed = new Set<string>();
  for (const cap of [...GRAPH_REQUIRED_CAPS, ...GRAPH_OPTIONAL_CAPS]) {
    const keeper = cap.anyOf.find((r) => have.has(r.toLowerCase()));
    if (keeper) needed.add(keeper.toLowerCase());
  }
  for (const r of USED_NON_GRAPH_ROLES) needed.add(r.toLowerCase());

  const escalation = new Map(Object.entries(GRAPH_ESCALATION_ROLES).map(([k, v]) => [k.toLowerCase(), v]));
  const out: SurplusRole[] = [];
  for (const role of granted) {
    const key = role.toLowerCase();
    const esc = escalation.get(key);
    if (esc) { out.push({ role, escalation: true, why: esc }); continue; }
    if (needed.has(key)) continue;
    // Redundant, or simply never called? Name the narrower role so the answer is actionable.
    const covered = [...GRAPH_REQUIRED_CAPS, ...GRAPH_OPTIONAL_CAPS].find((c) => c.anyOf.some((r) => r.toLowerCase() === key));
    const narrower = covered?.anyOf.find((r) => have.has(r.toLowerCase()));
    out.push({
      role,
      escalation: false,
      why: narrower
        ? `redundant — ${narrower} is also granted and already covers "${covered!.need}", with less authority`
        : "the engine never calls anything that needs this",
    });
  }
  // Escalation first: that is the part a security review needs to see.
  return out.sort((a, b) => Number(b.escalation) - Number(a.escalation) || a.role.localeCompare(b.role));
}
