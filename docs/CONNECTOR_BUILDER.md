# Connector builder — low-code system onboarding

Status: v1 shipped (this doc is the build contract; update it when the schema grows).

## Why

The long tail of client systems (SharePoint, Notion, Printix, Dropbox, niche portals…)
each cost a hand-written `Coretelligent.*` module today. Most of them are "call two or
three HTTP endpoints" or "click four things in a portal". The connector builder turns
that into **data**: an admin defines a connector in the UI (or imports one from a HAR
capture / Playwright codegen paste), publishes it, and the existing engine plans and
runs it like any built-in system — same jobs, same claim gate, same credential broker,
same audit trail. No new PowerShell, no runner deploy per system.

Two generic interpreters execute definitions:

- `Coretelligent.Connector` (runner module) — interprets `kind: "http"` definitions
  (REST/JSON APIs, webhook-style calls).
- `runner/browser/flows/connector-steps.mjs` — interprets `kind: "browser"` definitions
  (declarative Playwright step lists) via the existing browser bridge.

## Data model

```prisma
model Connector {
  id           String    @id @default(cuid())
  key          String    @unique          // systemKey, always "custom-…"
  name         String
  kind         String                     // http | browser
  status       String    @default("draft") // draft | published | archived
  definition   Json                       // the versioned definition (below)
  secretNames  String[]                   // logical secret names the definition references
  notes        String?
  createdBy    String?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  publishedAt  DateTime?
}
```

Publishing upserts a `SystemCatalog` row (`key`, `name`, `defaultMode` api|browser,
`moduleName: "Coretelligent.Connector"`, `buildTier: 3`, supports flags from which lanes
exist). Clients then attach it exactly like any system — a `ClientSystem` row via the
existing systems editor; per-client parameters live in `ClientSystem.config.onboard` /
`.offboard` as usual, secrets in `ClientSystem.secretNames` (wired to Delinea like every
other secret). Nothing else in planning changes: `planCase` already treats systems as
data.

**Definition delivery**: at claim time the app injects the *published* definition into
the job as `config.connector` (same pattern as `mailboxSizeGB` / `writebackEmail`
injection in `runner-service.claim`). The runner keys off `config.connector` — when
present and the systemKey has no built-in `$DISPATCH` entry, it routes to the generic
executor. Re-runs pick up the latest published definition automatically.

## Definition schema (kind: "http")

```jsonc
{
  "version": 1,
  "kind": "http",
  "baseUrl": "https://api.vendor.com/v1",
  "hosts": ["api.vendor.com"],          // ALLOWLIST: requests may only target these hosts
  "auth": {
    "type": "bearer" | "basic" | "header" | "oauth2-client-credentials",
    "secretName": "custom-vendor-api",  // logical name; wired per client in Delinea
    // bearer/basic default to the secret's username/password fields.
    // header: { "header": "X-Api-Key", "valueTemplate": "{{secret.custom-vendor-api.password}}" }
    // oauth2-client-credentials: { "tokenUrl": "...", "scope": "...", (id/secret from the secret's fields) }
  },
  "defaults": { "headers": { "Accept": "application/json" } },
  "operations": {
    "find-user":    { "request": { "method": "GET", "path": "/users?email={{user.email}}" },
                      "expect": { "status": [200] },
                      "extract": { "userId": "results.0.id" } },
    "create-user":  { "request": { "method": "POST", "path": "/users",
                                    "body": { "email": "{{user.email}}", "name": "{{user.displayName}}" } },
                      "expect": { "status": [200, 201] }, "extract": { "userId": "id" } },
    "disable-user": { "request": { "method": "POST", "path": "/users/{{vars.userId}}/deactivate" },
                      "expect": { "status": [200, 204] } }
  },
  "lanes": {
    "test":    [ { "op": "find-user", "optional": true } ],
    "onboard": [ { "op": "find-user" },
                 { "op": "create-user", "skipWhen": "vars.userId" } ],   // idempotency: exists → adopt
    "offboard": [ { "op": "find-user" },
                  { "warnWhen": "!vars.userId", "message": "no account found — nothing to offboard" },
                  { "op": "disable-user", "when": "vars.userId" } ]
  }
}
```

- **Templates** `{{root.path}}` resolve against: `user` (case payload), `config` (the
  job's lane config, minus the injected definition), `secret.<name>.<field>` (brokered
  Delinea fields), `vars` (accumulated `extract`s), `client` (slug/primaryDomain).
  Substitution happens on *string values inside structured bodies*, never on serialized
  JSON — a value can't break out of its JSON string.
- **Conditions** (`when`/`skipWhen`/`warnWhen`/`failWhen`) are dotted-path truthiness with
  optional leading `!`. Deliberately not an expression language.
- **expect** = allowed status codes plus optional `{ "path": "...", "equals"/"exists" }`
  body checks. An unexpected response fails the step with a redacted snippet.
- **extract** = dotted paths (array indexes allowed) into `vars`.
- **Idempotency is a first-class pattern, not an afterthought**: every lane is expected
  to open with a read (`find-user`) and gate mutations with `when`/`skipWhen`. The
  builder UI scaffolds this shape.

## Definition schema (kind: "browser")

```jsonc
{
  "version": 1,
  "kind": "browser",
  "startUrl": "https://portal.vendor.com/login",
  "credentials": { "secretName": "custom-vendor-portal" },   // username/password (+ optional TOTP seed in Delinea)
  "lanes": {
    "offboard": [
      { "type": "goto",   "url": "{{def.startUrl}}" },
      { "type": "fill",   "target": { "label": "Email" },    "value": "{{secret.username}}" },
      { "type": "click",  "target": { "role": "button", "name": "Next" } },
      { "type": "fill",   "target": { "label": "Password" }, "value": "{{secret.password}}", "secret": true },
      { "type": "totp",   "target": { "label": "Code" } },   // minted via the job's OTP broker at fill time
      { "type": "waitFor","target": { "text": "Dashboard" } },
      { "type": "fill",   "target": { "placeholder": "Search users" }, "value": "{{user.email}}" },
      { "type": "click",  "target": { "text": "Deactivate" } },
      { "type": "expect", "target": { "text": "User deactivated" } }
    ]
  }
}
```

Step types: `goto, fill, click, press, select, waitFor, expect, totp, sleep, screenshot`.
Targets: exactly one of `css`, `role`(+`name`), `label`, `placeholder`, `text`, `testId`.
`secret: true` values are never logged/echoed; a screenshot is captured on failure and
before every `expect` (evidence). Browser connectors are central-runner-only and gated by
the existing `browser` capability; their systemKeys join `BROWSER_SYSTEMS` dynamically.

## Import paths (the no-code part)

- **HAR import** (`kind: http`): upload a HAR captured while doing the task by hand in
  the vendor portal/API client. The app filters requests (target host, JSON/form bodies,
  non-static), strips cookies + auth headers + query secrets, and proposes one operation
  per interesting request. The admin enters the sample values used during capture (the
  test user's email, name…) and the importer rewrites every literal occurrence into the
  matching `{{user.*}}` placeholder. The admin then names ops and drags them into lanes.
- **Playwright codegen paste** (`kind: browser`): run `npx playwright codegen <portal>`,
  do the task once, paste the generated script; the importer parses the common
  `page.getByRole/getByLabel/fill/click` calls into declarative steps. Values matching
  entered samples become placeholders, the password fill becomes `{{secret.password}}`.

Both importers produce a *draft* — an admin reviews every operation/step before publish.

## Security invariants (enforced server- and runner-side, not just UI)

1. **Host allowlist**: the executor refuses any resolved URL whose host is not in
   `hosts` (http) / whose navigation target host is not the startUrl's host or an
   explicitly listed one (browser). A template cannot redirect a secret elsewhere.
2. **Secrets by reference only**: definitions carry logical secret names; values are
   brokered per-job by the existing least-privilege broker and never stored/logged.
   Response/request logs redact any occurrence of brokered field values.
3. **Publish is `global_admin`-gated** and audited (`connector.publish` AuditLog rows);
   a draft is never claimable because only publish creates/updates the SystemCatalog row
   and only published definitions are injected at claim.
4. **No arbitrary code**: definitions are declarative data validated against a strict
   schema on save AND on the runner before execution; unknown fields/step types fail
   closed.
5. **`custom-` prefix enforced** so a connector can never shadow a built-in systemKey's
   dispatch entry (runner checks built-ins first regardless).

## Claim path (both kinds)

Connector systems are catalogued `defaultMode: "api"` **regardless of kind**, matching the one
pre-existing browser system (`spanning-force-sync`). The job claim query filters `mode: "api"`; a
browser connector is routed by (a) its systemKey being withheld from non-Playwright agents via the
browser capability gate, and (b) the runner reading `config.connector.kind` to pick the browser
interpreter. Cataloguing a browser connector `"browser"` would put its jobs outside the `mode: "api"`
candidate query and they'd never be claimed — so we don't.

## Out of scope for v1 (deliberate)

Interactive OAuth grants (auth-code flow), inbound webhooks (vendor→app callbacks), SCIM,
client-network routing for connectors (all connector jobs run on the central runner; an
on-prem REST appliance needs `runCloudOnOwnAgent` for now), an in-browser step recorder
(codegen paste covers it), and per-connector rate limiting.
