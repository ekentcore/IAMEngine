# Operator authentication, RBAC & account management — plan

Status: design (not yet built). Closes the systemic "no operator auth" gap that every recent
security review flagged. Built first for internal Coretelligent staff, designed so it extends to
client-facing access later without a repaint.

Stack: **Auth.js (NextAuth v5)** — App-Router-native, owns sessions + CSRF. Microsoft Entra ID
(365) as the primary identity provider; local accounts (Credentials) for break-glass + non-365.

---

## 1. Principles

- **Default-deny.** No one gets in until provisioned *and* approved.
- **Every action attributable** to a real person — thread the authenticated user into every audit row (replace today's `actor:"ui"`/`"system"`).
- **365 SSO primary**, local accounts only for break-glass and non-365 users.
- **Least privilege** via roles; UI hiding is never the control — enforce server-side.
- **MFA everywhere**: Entra enforces its own (Conditional Access); local accounts get app-level TOTP.
- **Tenancy-ready**: model a `scope` dimension now so client users can later be limited to their org.

---

## 2. Getting the Entra client ID + secret, and locking it to our tenant

This is done once in the Azure portal by a Global Admin / App Admin.

### Register the app
1. **Azure Portal → Microsoft Entra ID → App registrations → New registration.**
2. Name: `iam-engine (Coretelligent)`.
3. **Supported account types → "Accounts in this organizational directory only (Single tenant)".**  ← **tenant lock #1** (Microsoft won't issue tokens for other tenants).
4. **Redirect URI** → platform **Web** → `https://<app-host>/api/auth/callback/microsoft-entra-id`. Add a second for dev (`http://localhost:3000/api/auth/callback/microsoft-entra-id`).
5. Register.

### Collect the three values
- **Application (client) ID** → `AUTH_MICROSOFT_ENTRA_ID_ID`
- **Directory (tenant) ID** → used in the issuer below
- **Certificates & secrets → New client secret →** copy the **Value** (shown once) → `AUTH_MICROSOFT_ENTRA_ID_SECRET`. Set expiry to 24 months and calendar a rotation reminder. *(Hardening option: use a **certificate** credential instead of a secret — no expiring secret on disk.)*

### Env (root `env.env`)
```bash
AUTH_SECRET="<openssl rand -base64 33>"                # signs the session JWT
AUTH_MICROSOFT_ENTRA_ID_ID="<application (client) id>"
AUTH_MICROSOFT_ENTRA_ID_SECRET="<client secret value>"
AUTH_MICROSOFT_ENTRA_ID_ISSUER="https://login.microsoftonline.com/<tenant-id>/v2.0/"   # tenant lock #2
APP_URL="https://<app-host>"
```
The **tenant-scoped issuer** makes Auth.js validate that tokens came from *our* directory (tenant lock #2).

### API permissions
Microsoft Graph → **delegated**: `openid`, `profile`, `email`, `User.Read` → **Grant admin consent**.

### Lock down *who* can sign in (recommended — "whose allowed in" at the directory level)
- **Entra → Enterprise Applications → iam-engine → Properties → "Assignment required?" = Yes.**
- **Users and groups →** assign only a specific security group (e.g. `iam-engine-operators`). Microsoft then blocks everyone else *before the app is even reached*.
- This pairs with the **app-level** approval/roles (§5) for defense in depth.

### Tenant lock = three layers
1. Single-tenant app registration · 2. tenant-scoped issuer Auth.js validates · 3. app-side `signIn` callback re-checks `profile.tid === <tenant-id>` and email domain ∈ allowlist (`core.tech`, `coretelligent.com`).

---

## 3. Auth.js wiring (App Router)

`web/auth.ts`:
```ts
import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },   // JWT required for the Credentials provider
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,   // tenant-scoped
    }),
    Credentials({                                          // local + break-glass
      credentials: { email: {}, password: {}, totp: {} },
      authorize: async (c) => verifyLocalUser(c),          // argon2 verify + TOTP check; null on fail
    }),
  ],
  callbacks: {
    async signIn({ user, profile, account }) {
      // tenant lock #3 + default-deny: only our tenant, only an active app user
      if (account?.provider === "microsoft-entra-id" && profile?.tid !== TENANT_ID) return false;
      const u = await upsertAndLoadAppUser(user, profile, account);  // provision pending on first SSO
      return u.status === "active";                        // pending/disabled → blocked
    },
    async jwt({ token, user }) {
      if (user) { token.uid = user.id; token.role = user.role; token.tv = user.tokenVersion; }
      // force-logout on disable/role change: bump tokenVersion -> stale tokens rejected
      if (token.uid && (await tokenVersionFor(token.uid)) !== token.tv) throw new Error("session revoked");
      return token;
    },
    session({ session, token }) {
      session.user.id = token.uid; session.user.role = token.role; return session;
    },
  },
});
```
`web/app/api/auth/[...nextauth]/route.ts` → `export const { GET, POST } = handlers;`

### Middleware split (the gap-closer)
`web/middleware.ts` keeps the **runner** endpoints on the bearer token and puts the **operator**
surface behind a session:
- **Runner (machine principal):** `/api/agents/:path*`, `/api/jobs/:path*`, `/api/runner/:path*` → `RUNNER_API_TOKEN` (existing). *(Note: `/api/runner/*` should finally be gated too — tracked separately.)*
- **Operator (human principal):** everything else (`/`, `/clients`, `/cases`, `/agents`, `/users`, `/api/clients/:path*`, `/api/cases/:path*`) → valid Auth.js session or redirect to `/login`.
- **Public:** `/login`, `/api/auth/*`.

### Per-action enforcement
Server actions + operator routes call `auth()`, then `can(user, action, scope)`; on success set the
audit actor to `session.user.email`. CSRF: SameSite=Lax cookies + an `Origin` check on POST/PUT/DELETE.

---

## 4. Roles & permission matrix

Resources/actions (capabilities):
`clients.view · clients.edit · rules.edit · secrets.wire · cases.view · cases.run · cases.approve_destructive · cases.delete · agents.manage · agents.update · audit.view · users.manage · roles.assign · settings.manage`

| Role | view clients | edit clients/rules | wire secrets | view cases | run cases | approve destructive | delete cases | manage agents | self-update agents | view audit/logs | manage users | assign roles |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Owner / super-admin** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Admin** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (not owners) | ✓ (≤ own) |
| **Operator** | ✓ | ✓ | – | ✓ | ✓ | – | – | ✓ | ✓ | own actions | – | – |
| **Approver** (separation of duties) | ✓ | – | – | ✓ | – | ✓ | – | – | – | ✓ | – | – |
| **Config editor** | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | – | – | – |
| **Auditor / log reviewer** | ✓ (no secret values) | – | – | ✓ | – | – | – | – | – | ✓ | – | – |
| **Viewer / read-only** | ✓ (no secret values) | – | – | ✓ | – | – | – | – | – | – | – | – |
| **Client-scoped operator** *(future)* | own org | own org | – | own org | own org | – | – | – | – | own org | – | – |
| **Break-glass** *(special local)* | full admin, normally **disabled**, MFA-required, every use high-visibility audited | | | | | | | | | | | |

Implementation: a `Role` enum + a `CAPABILITIES: Record<Role, Set<Capability>>` map and a pure
`can(user, capability, scope?)` helper (unit-tested). Start here; graduate to a `Permission` table
only if per-user custom grants are needed. `cases.approve_destructive` stays distinct so an
operator can run work but a second person approves offboarding (separation of duties).

---

## 5. Account lifecycle & management

### Data model (new)
`User`: `id, email (unique), name, image, authProvider (entra|local), entraOid?, status (pending|active|disabled), role, clientScope (null=all | clientId[]), passwordHash? (argon2id, local only), totpSecret? (encrypted), totpEnabled, recoveryCodes? (hashed), tokenVersion (int, bump to force-logout), failedLogins, lockedUntil?, createdAt, lastLoginAt, mfaEnrolledAt`.
Auth.js JWT strategy ⇒ **no Session/Account tables needed**. `AuditLog` already exists — add the actor.

### Provisioning ("whose allowed in")
- First Entra SSO → `User` created **pending** (no access). An **admin approves** and assigns a role + scope. (Or pre-invite by email; SSO activates a matching invite.) Pairs with Azure "assignment required".
- **Add account**: admin invites by email. 365 users → SSO. Local users → admin creates with a one-time temp password (forced change at first login).

### Password reset
- **Local accounts**: (a) admin-initiated reset → temp password + force-change; (b) self-service via emailed single-use token (uses the existing Mimecast/SMTP secret).
- **365 accounts**: never hold a password — Entra owns it; "reset" = a link to the Microsoft flow.

### TOTP / MFA
- **365**: enforce via **Entra Conditional Access / MFA** (recommended; nothing to build).
- **Local**: app-level **TOTP** (`otpauth` + `qrcode`): enroll (QR), verify a 6-digit code as a second step at login, store the secret **encrypted** at rest. Issue **recovery codes** (store hashed). Admin can **reset MFA** for a locked-out user.

### Disable / offboard
- Admin sets `status=disabled` and bumps `tokenVersion` → the `jwt` callback rejects existing sessions immediately (not just at the 8h expiry).

### Break-glass account
- A single **local admin** account: long random password **stored in Delinea**, TOTP required, normally `disabled` (enable only during an incident). Every authentication and action under it writes a high-visibility audit row (and optionally fires an alert). Documented runbook for when/how to use and how to rotate after.

---

## 6. Security hardening

- `AUTH_SECRET` strong + in `env.env`; cookies `httpOnly, Secure, SameSite=Lax`; **HTTPS required** (redirect URIs need a stable host — ties to the hosting/deploy item).
- Short JWT `maxAge` (8h) + `tokenVersion` revocation for instant disable/role-change logout.
- **argon2id** password hashing; rate-limit local login + **lockout** after N failures (`failedLogins`/`lockedUntil`).
- Encrypt TOTP secrets at rest (app key, or store in Delinea).
- **Audit auth events**: login success/fail, logout, role/scope change, user create/disable, password reset, MFA enroll/reset, **break-glass use**.
- Rotate the Entra client secret before expiry (or use a certificate). Keep `User.Read`-only scope.

---

## 7. Future: client-facing (multi-tenant)

Design the internal system so the external one is additive:
- `User.clientScope` already limits which clients a user sees; internal staff = `null` (all), client users = their `clientId[]`. `can(user, action, client)` checks capability **and** scope.
- External identities via a **separate Entra app / Entra External ID (B2C)** or B2B guest invites — keep the internal single-tenant lock for staff; client users authenticate through their own path.
- The role matrix already has a `Client-scoped operator` row to slot client users into.

---

## 8. Phased delivery

- **Phase 0 (operator):** Azure app registration + env (above). Set "assignment required = Yes".
- **Phase 1:** Auth.js + Entra SSO + `/login` + middleware split + redirect. → login works, sessions exist.
- **Phase 2:** `User` table + provisioning/approval + `Role` enum + `can()` + thread the actor into every audit + **role-gate the destructive/config routes** the reviews flagged (case delete-forever, rules edit, agent self-update). → the gap is closed.
- **Phase 3:** Local Credentials provider + `/users` admin page (invite/approve/role/disable) + password reset + **break-glass**.
- **Phase 4:** TOTP/MFA for local + recovery codes + lockout/rate-limit + force-logout-on-disable.
- **Phase 5 (later):** client-facing tenancy scoping.

## 9. Decisions to confirm before building
1. Stable HTTPS host for redirect URIs (hosting plan).
2. Client **secret** vs **certificate** for the Entra app.
3. Email domains to allowlist; the security group for Azure "assignment required".
4. Session lifetime (8h?) and lockout thresholds.
5. SMTP sender for invites/resets (reuse the Mimecast/SMTP Delinea secret?).
6. Use Azure app-roles/assignment (recommended) in addition to app-side approval, or app-side only.
