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
    need: "remove MFA methods + revoke sessions on offboard",
    anyOf: ["UserAuthenticationMethod.ReadWrite.All"],
    why: "without it a leaver's registered second factors (phone / Authenticator / FIDO2) stay on the account and go live again the moment it is re-enabled; offboard warns and continues",
  },
  {
    need: "read the tenant's verified email domains (multi-domain clients)",
    anyOf: ["Domain.Read.All"],
    why: "needed only when a client has more than one verified email domain, to pick the right one; single-domain clients are unaffected",
  },
  {
    need: "read whether a leaver's mailbox was converted to shared",
    anyOf: ["MailboxSettings.Read", "MailboxSettings.ReadWrite"],
    why: "without it the leaked-seat scan can still see that a disabled user is still licensed, but cannot say whether their mailbox was converted to shared — so it can't tell you whether the licence is safe to remove yet",
  },
];

// The Entra portal needs an app-role ID, not a name, to grant a permission non-interactively. Only
// the ids we hand out in add-instructions live here; a name with no id still gets portal steps.
export const GRAPH_APP_ROLE_IDS: Readonly<Record<string, string>> = {
  "UserAuthenticationMethod.ReadWrite.All": "50483e42-d915-4231-9639-7fdb7fd190e5",
  "Domain.Read.All": "7e05723c-0bb0-42da-be95-ae9f08a6e53c",
  "MailboxSettings.Read": "40f97065-369a-49f4-947c-6a255697ae91",
};

// The Microsoft Graph resource app id — the service principal that owns all of the roles above.
export const GRAPH_RESOURCE_APP_ID = "00000003-0000-0000-c000-000000000000";

export type CapRow = { need: string; anyOf: string[]; ok: boolean; optional: boolean; why?: string };

function satisfied(cap: GraphCap, granted: readonly string[]): boolean {
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
