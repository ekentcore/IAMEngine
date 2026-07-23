# DB-copy connection form + staged probe — design

Date: 2026-07-23
Status: approved (brainstorm), implementing

## Problem

`/tools/db-copy` clones the app's Postgres DB from the source (`POSTGRES_*`) into a destination
(`POSTGRES_*1`). Today the destination is configured only by hand-editing `env.env` on disk, and a
failed connection surfaces as a single scrubbed one-line pg error. An operator standing up the
migration destination (e.g. Azure Postgres) can't see *what* it's connecting to or *where* it's
failing.

## Goals

1. An in-app **form** for the destination connection (host, port, user, database, schema, password) —
   no more editing `env.env`.
2. **Staged, side-by-side feedback** for both source and destination showing every step of the
   connection attempt (everything except the password).
3. Once the destination probe is green, run the existing copy from the form.

Non-goals (YAGNI): MongoDB destination (not viable — copy engine is `pg_dump | psql` and the app is
Prisma/Postgres); editing the source connection; live per-table streaming during the copy.

## Persistence

New app-setting key `db_copy.destProfile` = `{ host, port, user, database, schema }`. Saved
automatically on every Test. **The password is never persisted** — not to the setting, `env.env`, or
logs. It lives only in the form field and the request body for one action. On load the form pre-fills
from the saved profile, falling back to `env.env` `POSTGRES_*1` when none is saved yet.

## Staged probe (`lib/db-copy/probe.ts`)

`probeConnection(conn, deps?)` runs ordered steps, each `{ step, label, status: ok|fail|skipped,
detail?, ms?, error? }`:

| step          | does                                                        |
|---------------|-------------------------------------------------------------|
| config        | echoes host/port/user/db/schema (always ok when present)    |
| reachable     | raw TCP `net.connect(host,port)`, ~5s timeout, reports ms   |
| authenticated | `pg` connect to the target db                               |
| database      | (attributed from the connect error when the db is missing)  |
| version       | `SELECT version()`                                          |
| tables        | count base tables in schema                                 |

On the first failure, remaining steps are `skipped`. The `pg` `connect()` call covers both auth and
db-existence, so a **pure** `classifyConnectFailure(code, message)` maps the error to the right step:
`3D000`/"database … does not exist" → `database`; `28P01`/`28000`/"authentication" → `authenticated`;
`ENOTFOUND`/`EAI_AGAIN`/`ECONNREFUSED`/`ETIMEDOUT`/`EHOSTUNREACH` → `reachable`; else →
`authenticated`. Every message runs through `sanitizeError`; `label` uses `connLabel` (never the
password). Dependency injection (`deps = { tcpCheck, connect }`) makes it testable without a live DB.

## API routes

- `POST /api/tools/db-copy/probe` — body: destination fields + password. Probes source (from config)
  and destination (from body) in parallel; side-effect-saves the non-secret dest profile. Returns
  `{ source: ProbeResult, dest: ProbeResult }`. Guard `settings.manage`.
- `GET /api/tools/db-copy` — returns the saved dest profile (no password) + source label + (when both
  reachable) the table preview, to hydrate the form.
- `POST /api/tools/db-copy` (copy) — takes the destination connection from the request body instead of
  `env.env`; keeps the typed-DB-name confirmation and the `sameTarget` self-copy refusal. Audit detail
  unchanged (host/port/db only — never the password).

## UI (`app/tools/db-copy/_components/db-copy-view.tsx`)

Two cards side by side. Source: read-only identity + its probe step list. Destination: the editable
form + its probe step list. Test button runs the probe; Copy button (typed confirmation) is disabled
until the destination probe is fully green.

## Security

`settings.manage` on every route (unchanged). Password transient only, scrubbed everywhere, never
stored. App runs over http on the LAN, so the typed password crosses the wire in a POST body in
plaintext — the same exposure as every other credential the app already brokers; noted, not new.

## Testing

- `classifyConnectFailure` — table of SQLSTATE / errno → expected step (the core logic; pure).
- `probeConnection` with injected fakes — all-green path; auth-fail path (earlier steps ok, later
  skipped); assert the password string never appears in `JSON.stringify(result)`.
- Profile save omits the password.
