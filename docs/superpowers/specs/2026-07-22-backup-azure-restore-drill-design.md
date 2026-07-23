# Feature #5 — Backups to Azure Blob + automated restore drill

Design spec. **No code in this document.** Status: draft for Evan's review.
Author: Claude (Opus 4.8). Date: 2026-07-22.

---

## 1. Purpose & gap

Today the database has one home (a Postgres reachable from Evan's Mac) and one backup
mechanism: nightly `pg_dump -Fc` to `~/Backups/iam-engine/` on that same Mac
(`web/lib/jobs/db-backup.ts` in-app + `web/scripts/db-backup/*` launchd), verified
readable with `pg_restore --list`, rotated at 30 days (PR #26). Two gaps, both about to
get worse when the DB moves to Azure tomorrow:

1. **Dumps live on the same box as the app.** They are a local-disk copy, not
   off-box durable storage. A lost Mac (or, post-migration, a lost app VM) loses both
   the running DB's neighbourhood and every restore point. On Azure the dumps must land
   in **Azure Blob Storage** — a different failure domain from the DB and the app.
2. **The backups have never been restored on a schedule.** `restore.sh` was
   round-trip verified *once* by hand (PR #26). "Backups you've never restored aren't
   backups." We need a **scheduled restore drill** that takes the latest dump, restores
   it into a throwaway scratch DB, runs integrity assertions, tears the scratch DB down,
   and **alerts if any step fails** — proving the restore path continuously, not once.

This feature is the durable-storage + proof-of-restore layer on top of the existing,
working dump machinery. It reuses that machinery; it does not replace it.

Two derived signals also matter to sibling features: **#3 (health dashboard)** and
**#6 (readiness)** both want a single "are backups fresh and restorable?" boolean. This
spec exposes that (§3.7).

---

## 2. Current state (file:line)

Everything below already exists and is the reuse surface.

**In-app nightly dump** — `web/lib/jobs/db-backup.ts`
- `sweepDbBackup(db)` (`:203`) — heartbeat-driven entry, self-throttles to 1/min
  (`TICK_EVERY_MS`, `:200`), claims the night via `claimAppSetting` (`:214`), runs the
  dump, records result, audits, fires `backupFailed` on failure (`:229`).
- `runDbBackup(s)` (`:128`) — the reusable dump: strips Prisma's `?schema=` param
  (`:136`), `pg_dump --format=custom` to a `.partial` then verifies with
  `pg_restore --list` before renaming and re-pointing `latest.dump` (`:149`–`:162`),
  prunes past `keepDays` (`:163`, `pruneOldDumps :173` — never prunes the `latest.dump`
  target).
- `DbBackupSetting` / `normalizeDbBackup` (`:42`, `:56`) — AppSetting shape; **default-ON**
  (`enabled` missing ⇒ true, `:59`); `keepDays` default 30 (`:61`); `backupDir` default
  `~/Backups/iam-engine` (`defaultBackupDir :51`).
- `backupDue(s, now)` (`:93`) — "due once per local day at/after `hourLocal`"; anchors to
  the night boundary, treats an unparseable stamp as due.
- `findPgBin(tool)` (`:106`) — locates `pg_dump`/`pg_restore` outside PATH under launchd.
- `sanitizeError(msg)` (`:122`) — **critical**: `execFile` error text embeds the full
  connection URL incl. password; anything stored/notified/rendered is scrubbed here.
- `recordRunResult(db, result)` (`:193`) — re-reads + merge-writes so a run's outcome
  never clobbers an operator's concurrent toggle.
- `DbBackupResult` (`:33`) — `{ ok, file, sizeBytes, dataTables, error, at }`.

**Standalone launchd layer** — `web/scripts/db-backup/`
- `backup.sh` — mirror of `runDbBackup` in bash (dump→verify→symlink→prune),
  same `find_pg_bin` keg list, resolves `DATABASE_URL` from `web/.env` (`:41`–`:51`).
- `restore.sh` — **scratch-DB restore by default** (`<db>_restore_<timestamp>`, `:98`);
  `--replace --yes` for disaster recovery over the live DB; `--target-db` for a named DB;
  `--exit-on-error` so a partial restore can't silently look complete (`:141`); reports
  table count after restore (`:144`). **This is the drill's building block.**
- `install-schedule.sh`, `README.md` — the launchd agent + the TCC caveat below.

**macOS TCC caveat** (memory `feature-db-backup.md`, README): a *new* launchd agent is
denied Local Network until a manual Allow in System Settings; children of the
already-granted web-app process inherit the grant, which is why the *in-app* pg_dump
works on day one and the standalone agent needed a click. **This caveat is macOS-only and
evaporates on Azure** — the app VM's outbound to Blob and to Postgres is governed by NSGs,
not TCC.

**Wiring** — `web/lib/jobs/runner-service.ts:476` fires `void sweepDbBackup(db)` on every
heartbeat, alongside `sweepConnTests` (`:473`), `sweepServiceNowIntake` (`:469`),
`sweepProcurementWatches` (`:466`). This is the "app pulse". A new drill sweep hangs here.

**Settings helpers** — `web/lib/settings.ts`
- `getAppSetting` / `setAppSetting` / `claimAppSetting` — the latter is the race-safe
  conditional claim; the memory note is explicit: **never copy the old read-compare-write
  pattern; use `claimAppSetting` for any new sweep.**

**Alerting** — `web/lib/notifications/`
- `fireNotification(e)` — `sender.ts:234`, reads config, honours master switch +
  per-event toggle, audits, **never throws**.
- `NotifEvent` union + `NOTIF_EVENTS` list — `types.ts:11`, `:14`. `backupFailed`
  already exists (`:24`, default-on `:73`). Config key `failure_notifications`
  (`NOTIFICATIONS_SETTING_KEY`, `types.ts:6`). Master switch is currently **off** by
  default (`DEFAULT_NOTIFICATIONS.enabled = false`, `:66`) — an operational note, not a
  code change for us.

**Admin surface** — `web/app/api/admin/db-backup/route.ts` (GET status / POST toggle
or `{action:"run"}`, guarded `settings.manage`), rendered by
`web/app/settings/_components/db-backup-card.tsx`, mounted at
`web/app/settings/page.tsx:61`.

**Secret model** — `web/prisma/schema.prisma`
- `Secret.externalId` — `:220`, comment **"Delinea secret id — NEVER a value"**. The DB
  stores *references*, not credentials.
- `User.passwordHash` — `:734`, `scrypt(salt:hash)`, local app logins only; hashed, not
  reversible.
- `ModuleSetupCredential.delineaSecretId` — `:985`, also a reference.
- **Confirmed: a `pg_dump` at rest contains no plaintext third-party secrets** — only
  Delinea external IDs and scrypt hashes. This governs the "dumps-at-rest" risk in §3.8.
- No Azure SDK dependency exists yet (`web/package.json` has no `@azure/*`).

---

## 3. Design

### 3.0 Shape of the work

Two new, mostly-independent pieces bolted onto proven machinery:

- **A. Off-box upload**: after `runDbBackup` writes and verifies a local dump, push it to
  Azure Blob. Local disk stays the fast/first restore point; Blob is the durable copy.
- **B. Restore drill**: a scheduled job that pulls the latest dump (local, else Blob),
  restores it into a scratch DB, asserts integrity, tears down, and alerts on failure.

Both are additive. If Azure config is absent, A no-ops (local backups continue exactly as
today) and B runs against the local `latest.dump` — so nothing regresses pre-migration.

### 3.1 Azure upload mechanism — recommendation: **`az` CLI via `execFile`** (not the SDK)

**Recommendation: shell out to the `az storage blob upload` CLI**, matching the existing
`execFile(pg_dump…)` pattern, rather than adding the `@azure/storage-blob` +
`@azure/identity` Node SDKs.

Rationale for *this* environment:
- **Symmetry with what already works.** The backup path is already a shell-out orchestrator
  (`execFileP(pgDump, …)`, `db-backup.ts:149`). The dump is a file on disk; the CLI's job
  is "upload this file." Adding two npm dependencies and a second auth model to move one
  file is disproportionate. The standalone `backup.sh` (bash) can call the identical CLI
  command, keeping the in-app and launchd layers in step exactly as they are today for
  `pg_dump`.
- **The tool is already a hard dependency of the deploy.** The Azure migration installs
  `az` on the app host regardless; `azcopy` would be a *second* tool to provision. `az`
  covers upload, container creation, and lifecycle-policy management (see below) with one
  binary.
- **Auth reuse without a code auth-model.** On the Azure VM, `az login --identity` (managed
  identity) or a stored SAS both work with the same command; the SDK's `DefaultAzureCredential`
  is elegant but pulls a whole credential-chain library in for a single upload.

Per Context7 (`/websites/learn_microsoft_en-us_azure_storage`, Azure Storage docs, current
as of 2026-07 fetch), the upload command is:

```
az storage blob upload \
  --account-name <storage-account> \
  --container-name <container> \
  --name <blobPath> \
  --file <localDumpPath> \
  --auth-mode login          # managed identity / logged-in principal
```

For reference, the SDK path the docs show — **not chosen**, but recorded so the trade-off
is legible — is `BlockBlobClient.uploadFile(localFilePath)` authenticated with
`new DefaultAzureCredential()` (passwordless, recommended by MS) or
`BlobServiceClient.fromConnectionString(connectionString)`. If a future need arises for
streamed/chunked upload with per-block progress, or to avoid a CLI dependency entirely,
the SDK is the clean escape hatch — swapping the one `execFile` call for `uploadFile` is a
localized change. **Revisit if** dumps grow past a few GB and we want block-level retry, or
if the deploy standardizes on passwordless SDK auth everywhere.

Same source, the two auth alternatives to `--auth-mode login`:
- **Account SAS** in a connection string (`SharedAccessSignature=sv=…&sig=…`) — a
  time-boxed, permission-scoped token; our preferred *secret-reference* path (§3.2).
- **Account key** connection string — avoid; long-lived, full-control.

Verify: **`--overwrite` semantics** — the drill and rotation assume each dump lands at a
unique, timestamped blob name (mirroring the local `${dbName}-${stamp}.dump`), so overwrite
should never be needed; a name collision is a bug worth failing on, not silently
overwriting.

### 3.2 Auth via secret reference — NEVER hardcode

The Azure Storage credential follows the project's secret discipline. **No account key or
SAS string is ever written into a profile, into `AppSetting`, into a dump, or into code.**
Two acceptable reference shapes, in preference order:

1. **Managed identity (no secret at all).** On the Azure VM, grant the app's system-assigned
   managed identity the **Storage Blob Data Contributor** role on the backup container.
   `az login --identity` then `--auth-mode login` needs no stored credential. This is the
   strongest option and the recommended default post-migration — it removes the credential
   from existence rather than protecting it.
2. **Delinea-brokered SAS**, consistent with every other third-party credential in the app
   (`Secret.externalId` = a Delinea reference, never a value). The AppSetting under
   `backup.azure.credentialRef` (§4/S3) holds a **Delinea external ID**; at run time the
   app brokers a short-lived SAS/connection-string from Delinea exactly as the runner
   brokers M365/AD creds, injects it into the CLI call's environment
   (`AZURE_STORAGE_CONNECTION_STRING`), and never persists it. The brokered value must pass
   through the *same* redaction as `sanitizeError` before any logging.

The spec's default is **(1) managed identity**; **(2)** is the fallback where managed
identity is unavailable (e.g. running the standalone launchd layer off-Azure during the
transition). Open question §7 for which lands first.

**`sanitizeError` must be extended** to also scrub SAS query strings (`sig=…`, `se=…`) and
`AccountKey=…` from any `az`/error output, the same way it scrubs the Postgres URL today
(`db-backup.ts:122`). An `az` failure message can echo the connection string.

### 3.3 Upload path (extends `runDbBackup`)

Minimal, additive:
- After the existing verify-and-rename step succeeds (`db-backup.ts:155`), and only if
  `backup.azure` config is present + enabled, upload the just-written dump to Blob under a
  deterministic path: `iam-engine/<dbName>/<dbName>-<stamp>.dump`.
- **Integrity checksum end-to-end.** Compute the dump's checksum locally (e.g. MD5/SHA-256)
  and pass/verify it on upload so a corrupted transfer is caught. Azure block-blob PUT
  supports a `Content-MD5` the service validates; record the checksum in the result so the
  drill (and a human) can confirm the blob matches the local file. Store the checksum in
  the `DbBackupResult`/blob metadata, not just a log line.
- The upload result extends `DbBackupResult` (§2 `:33`) with
  `{ blobUrl?, blobUploadedAt?, checksum?, uploadError? }`. **An upload failure must not
  fail the whole backup** — the local dump is still a valid restore point — but it MUST
  surface: set `uploadError`, audit `db.backup.upload_failed`, and fire a
  `backupFailed`-family alert (§3.6). A dump that exists only locally on a soon-to-be-gone
  box is a silent single point of failure; the alert is the point.
- **Blob-side rotation** mirrors local `keepDays` but is enforced by an **Azure lifecycle
  management policy** (see §3.4), not by the app deleting blobs — cheaper and outside the
  app's failure domain.

### 3.4 Retention / lifecycle

- **Local**: unchanged — `pruneOldDumps` at `keepDays` (default 30), never prunes the
  `latest.dump` target (`db-backup.ts:173`). Post-migration the local window can be *shorter*
  (e.g. 7 days) since Blob is now the system of record; expose as `backup.azure.localKeepDays`
  vs the existing `keepDays`. (Open question §7 — or just keep 30 both.)
- **Blob**: an Azure **lifecycle management policy** on the container ages dumps out
  automatically. Per Context7 (Azure Storage docs), applied once at setup with:

  ```
  az storage account management-policy create \
    --account-name <storage-account> \
    --policy @policy.json \
    --resource-group <resource-group>
  ```

  The policy JSON: tier blobs under `iam-engine/` prefix to Cool after N days and delete
  after `backup.azure.retentionDays` (default 90 — longer than local, since Blob is
  durable/cheap). This is **infra config, provisioned once**, not app runtime code — it
  belongs in the deploy runbook, referenced from this spec, with the JSON checked into
  `web/scripts/db-backup/azure/` for reproducibility.
- **Immutability (stretch)**: a container **legal hold / time-based immutability** policy
  would make dumps ransomware/`--replace`-accident resistant. Note as a §7 option; not
  in the first cut.

### 3.5 Restore-drill job + integrity assertions

A new sweep, `sweepRestoreDrill(db)`, structured exactly like `sweepDbBackup`:
self-throttle → check due → `claimAppSetting` the run → execute → record → audit → alert.

The drill mechanic reuses `restore.sh`'s **scratch-DB path** — this is the whole reason
`restore.sh` defaults to a scratch DB. The drill:

1. **Acquire the dump under test.** Prefer the local `latest.dump`; if absent (Azure-only
   host) **download the latest blob** first (`az storage blob download`), verify its
   checksum against the recorded one (§3.3), then treat it as the dump. Downloading the
   blob — not restoring the always-present local file — is the stronger drill because it
   exercises the *off-box* copy, the one we actually depend on in a disaster. **Prefer
   drilling the Blob copy** when Azure is configured.
2. **Restore into an isolated scratch DB** named `<db>_drill_<timestamp>` on the same server
   (reusing `restore.sh` scratch semantics, `restore.sh:98`, `--exit-on-error :141`). Never
   `--replace`. The drill must be *incapable* of touching the live DB — pass an explicit
   scratch target, never the live name, and assert the target name ≠ live name before
   running.
3. **Integrity assertions** against the scratch DB (fail the drill if any fail):
   - **Schema check**: the restored `public` schema has ≥ the expected table count
     (`restore.sh` already reads this, `:144`); compare against a floor and, better, against
     the *live* DB's current table list — a drift means a broken/partial dump.
   - **Row counts on key tables**: `Client`, `ClientSystem`, `Case`, `Job`, `AuditLog`,
     `Secret`, `User`, `AppSetting` — each must be > 0 (or within a sane delta of live). A
     dump that restored "successfully" but empty is the classic silent-bad-backup.
   - **Canary query**: a semantically meaningful read that touches a join, e.g. "count
     Clients that have ≥1 ClientSystem" or "the newest AuditLog row parses and is < 48h old
     relative to the dump's `at`". Proves the data is queryable, not just present.
   - **Referential spot-check**: no orphaned `ClientSystem.clientId` without a `Client`
     (a corrupt restore can drop FKs under `--no-owner`).
4. **Tear down** the scratch DB unconditionally (success or failure) — `DROP DATABASE
   <db>_drill_<timestamp>` in a `finally`, mirroring `restore.sh`'s teardown hint
   (`restore.sh:150`). A leaked scratch DB is a cost + confusion leak; teardown must be as
   robust as the tmp-file cleanup in `runDbBackup` (`:166`).
5. **Record** a `RestoreDrillResult` `{ ok, dumpUnderTest, source: "local"|"blob",
   checksumOk, tables, rowCounts, canaryOk, durationMs, scratchDb, error, at }` into the
   drill AppSetting (merge-write like `recordRunResult`) and an `AuditLog`
   (`db.restore_drill.completed` / `.failed`).

**Scratch-DB isolation & cost** (§3.8): the scratch DB is created and dropped within one
drill; it is transient. On Azure, if the target is **Azure Database for PostgreSQL Flexible
Server**, `CREATE DATABASE` on the same server instance is fine and free-ish (storage for
the few minutes it lives). Verify the connecting principal can `CREATE DATABASE`
(`restore.sh` header already states this requirement, `:20`). Drill cadence is weekly (§3.6)
so cost is a few restores/month.

### 3.6 Schedule

- **Backup**: unchanged — nightly, heartbeat-driven, `backupDue` at/after `hourLocal`.
- **Drill**: **weekly** by default (a full restore is heavier than a dump; nightly is
  overkill, monthly is too stale given the DB is changing homes). New AppSetting
  `backup.azure.drill` with `{ enabled, dayOfWeek, hourLocal, lastStartedAt, lastResult }`.
  A `drillDue(s, now)` predicate mirrors `backupDue` but on a weekly boundary (anchor to the
  configured weekday+hour; unparseable stamp ⇒ due).
- **Wiring**: add `void sweepRestoreDrill(db).catch(()=>{})` next to `sweepDbBackup` in
  `runner-service.ts:476`. Same heartbeat-pulse caveat applies (no heartbeat ⇒ no drill);
  acceptable, and the staleness signal (§3.7) catches a stalled pulse.
- **Default-ON** like the backup — a drill you have to remember to enable is a drill that
  won't run.

### 3.7 Freshness signal (for #3 health, #6 readiness)

Expose a single derived read that #3 and #6 consume — **do not have them re-implement the
staleness math.** A helper `backupFreshness(db)` returns:

```
{
  lastBackupAt, backupOk, backupAgeHours, backupStale,      // stale if > ~26h (memory's ">26h" idea)
  lastUploadAt, blobOk,                                      // off-box copy present + fresh
  lastDrillAt, drillOk, drillAgeDays, drillStale,           // stale if > ~8 days
  healthy   // backupOk && !backupStale && blobOk && drillOk && !drillStale
}
```

- Reads the `db_backup` and `backup.azure.drill` AppSettings' `lastResult`/`lastStartedAt`
  (already persisted). Pure derivation; no new writes.
- **This is the "backups fresh" signal named in S6.** #3 renders it as a health tile; #6
  gates readiness on `healthy`. Surface it via the existing admin route (extend
  `GET /api/admin/db-backup` to include a `freshness` block, or a sibling
  `GET /api/admin/backup-health`) — decision in §7.
- The **">26h without backup" staleness alert** the memory flagged as a follow-up belongs
  here: the drill sweep (or a tiny dedicated check on the pulse) fires `backupFailed`
  ("no backup in 26h") when `backupStale` — closing the gap where *no backup ran at all*
  (which today produces no failure, because nothing ran to fail).

### 3.8 Cross-cutting considerations

- **Secrets never in dumps-at-rest unencrypted** — confirmed §2: dumps hold Delinea
  *references* (`Secret.externalId`, "NEVER a value") and scrypt password hashes, not
  plaintext third-party creds. Still, the blob container should have **encryption at rest**
  (default on Azure Storage) and **private access only** (no anonymous/public container,
  no public network if the VNet allows a private endpoint). The dump is low-but-not-zero
  sensitivity (it contains the full client roster, case history, audit log) — treat the
  container as confidential: private endpoint or firewall-scoped, RBAC-gated, never a public
  SAS URL pasted anywhere.
- **Dump size/time**: `runDbBackup` already caps `pg_dump` at 10 min (`:149`) and reads the
  archive with a 32 MB `maxBuffer` for the `--list` (`:153`). Upload adds network time;
  the CLI handles its own chunking. If the DB grows large, the SDK escape hatch (§3.1) gives
  block-level retry. Record `durationMs` in results to watch the trend.
- **`sanitizeError` extension** (§3.2) is mandatory before any `az` output is logged.
- **Scratch-DB isolation** (§3.5): explicit scratch name, assert ≠ live, `finally`-drop.
- **Cost**: Blob storage for ~30–90 compressed dumps is pennies/GB-month (Cool tier via
  lifecycle); weekly scratch restores are minutes of transient DB storage. Negligible.

---

## 4. Shared-seam conformance

Per `docs/superpowers/specs/2026-07-22-finalization-seams-and-sequencing.md` (S3, S6;
the file is not yet present in this branch — reconcile keys with it when it lands).

**S3 — AppSetting keys under `backup.azure.*` (this feature owns them):**
- `backup.azure.enabled` — master switch for off-box upload (missing ⇒ treat as
  off/no-op pre-migration; flip on at cutover).
- `backup.azure.account` — storage account name (not a secret).
- `backup.azure.container` — container name.
- `backup.azure.credentialRef` — **Delinea external ID** for the SAS/connection string, OR
  the sentinel `"managed-identity"` meaning "use `--auth-mode login`, no stored secret".
  **Never a credential value.**
- `backup.azure.retentionDays` — Blob retention (default 90; enforced by lifecycle policy,
  §3.4).
- `backup.azure.localKeepDays` — optional shorter local window (else reuse existing
  `keepDays`).
- `backup.azure.drill` — `{ enabled, dayOfWeek, hourLocal, lastStartedAt, lastResult }`.
- Existing `db_backup` key (`DB_BACKUP_KEY`) is untouched in shape; its `lastResult` gains
  optional `{ blobUrl, blobUploadedAt, checksum, uploadError }` fields (backward-compatible
  — `normalizeDbBackup` ignores unknown fields today).

**S6 — reuse `failure_notifications`, do not fork alerting:**
- All alerts go through `fireNotification` (`sender.ts:234`) with `event: "backupFailed"`
  (already in the union, `types.ts:11`). Sub-cases (upload failed, drill failed, backup
  stale >26h) are distinguished in `title`/`detail`, **not** by new event keys — keeps the
  operator's single "backup" toggle authoritative. *(Optional §7: add a distinct
  `restoreDrillFailed` event key if operators want to route drill failures separately; the
  default is to reuse `backupFailed`.)*
- The **freshness signal** (§3.7) is the S6-named "backups fresh" input for #3/#6.

**Secrets seam:** §3.2 — managed identity preferred; else Delinea-brokered SAS via
`credentialRef`; never hardcoded; `sanitizeError` extended.

**Shared files this feature touches (coordinate — Wave A parallel-safe otherwise):**
- `web/lib/jobs/db-backup.ts` — extend `runDbBackup` result + upload call; extend
  `sanitizeError`. *(Owned by this feature; low collision risk.)*
- `web/lib/jobs/runner-service.ts:476` — **add one line** (`sweepRestoreDrill`). This is
  the shared "pulse" fan-out; the seams doc flags it — append only, don't reorder.
- `web/lib/notifications/types.ts` — **only if** the optional `restoreDrillFailed` event is
  adopted (§7). Default: no change (reuse `backupFailed`).
- `web/app/api/admin/db-backup/route.ts` + `db-backup-card.tsx` — extend status surface
  with upload + drill + freshness (additive).
- **New files** (no collision): `web/lib/jobs/restore-drill.ts`, `web/lib/jobs/backup-blob.ts`
  (upload/download/checksum helpers), `web/lib/jobs/backup-freshness.ts`,
  `web/scripts/db-backup/azure/lifecycle-policy.json`, and a drill card component.

---

## 5. Testing

Follow the runner-pwsh / web-vitest split already in the repo. This is web-side.

- **Pure-function unit tests (no Azure, no DB):**
  - `drillDue(s, now)` — weekly boundary math, unparseable-stamp ⇒ due, disabled ⇒ false
    (mirror the existing `backupDue` reasoning).
  - `backupFreshness` — staleness thresholds (26h / 8d), `healthy` truth table incl. the
    "upload failed but local ok" and "backup fresh but drill stale" cases.
  - `sanitizeError` — add cases for SAS (`sig=`, `se=`), `AccountKey=`, and
    `AZURE_STORAGE_CONNECTION_STRING` echoes; confirm the existing Postgres-URL case still
    passes.
  - Blob path/name derivation + checksum computation determinism.
- **Integration (local, no cloud):** the **drill against the local `latest.dump`** is
  runnable on any dev box — create dump via `runDbBackup`, run `sweepRestoreDrill` forced,
  assert scratch DB created→asserted→dropped, and that a deliberately-truncated dump makes
  the drill *fail and alert*. Use the shared dev DB with the fixture rules from the
  `web-dev-verify-recipe` memory; scratch DB name must be unique per run.
- **Upload path**: gate real-Azure tests behind an env flag (`AZURE_STORAGE_*`), skipped in
  CI. Manually validate once against the real container at cutover — checksum round-trips,
  lifecycle policy applies, managed-identity auth works from the VM. (Cite: azure-inventory
  memory — committed report generators leaked a client roster once; keep any test output out
  of git.)
- **Alerting**: `fireNotification` is already covered (`sender.test.ts`); add a test that a
  failed drill / stale-backup calls it with `event:"backupFailed"` and a redacted detail.
- **Negative-restore assertion**: the single most valuable test — feed the drill a *bad*
  dump (empty, wrong-schema, truncated) and prove it fails loudly. A drill that can't fail
  is theatre.

---

## 6. Sequencing & dependencies

- **Wave A, parallel-safe** (per seams doc): this is "backup scripts + a schedule + a small
  status surface." No dependency on #1/#2/#4. Only shared touch is the one appended line in
  `runner-service.ts:476` and the S3/S6 key/enum conventions.
- **Feeds #3 (health) and #6 (readiness)** via the freshness signal (§3.7) — build the
  signal early so those features can consume it; they depend on *its shape*, not its
  internals.
- **Migration timing**: the app moves to Azure "tomorrow." Split delivery so nothing blocks
  the move:
  1. **Pre-migration (safe now):** restore-drill against the local dump + freshness signal
     + staleness alert + `sanitizeError` hardening. All testable on the Mac today; upload
     no-ops with no Azure config.
  2. **At/after cutover:** provision the storage account + container + RBAC/managed identity
     + lifecycle policy (runbook), flip `backup.azure.enabled`, switch the drill to prefer
     the Blob copy. Validate end-to-end on the VM.
- **Runner version**: web-only, **no runner change** — do **not** bump `runner/VERSION`
  (currently 1.94.0). The pg tools run in-app; the runner just heartbeats.
- **No migration** (Prisma) required — all state is in `AppSetting` JSON.

---

## 7. Open questions for Evan

1. **Auth: managed identity vs Delinea-brokered SAS as the first cut?** Managed identity is
   strongest and needs no secret, but only works once we're on the Azure VM. Do we ship the
   Delinea-SAS path too for the transition window (and for the off-Azure launchd layer), or
   go managed-identity-only and accept upload is dark until cutover? *(Riskiest question —
   it gates whether upload works before or only after the move.)*
2. **Which Postgres on Azure?** Flexible Server vs a VM-hosted Postgres changes whether the
   drill can `CREATE DATABASE` on the same instance (assumed yes) and where the scratch DB
   lives. Confirm the connecting principal has `CREATEDB`.
3. **Drill cadence + target**: weekly OK? And should the drill *always* download-and-restore
   the **Blob** copy (truest test of the off-box path) even when a local dump exists?
   Recommendation: yes, once Azure is live.
4. **Retention split**: keep 30 days local / 90 days Blob, or shorten local to 7 once Blob is
   authoritative?
5. **Separate `restoreDrillFailed` alert event, or reuse `backupFailed`?** Default is reuse
   (one operator toggle); split only if drill noise needs separate routing.
6. **Freshness surface**: extend `GET /api/admin/db-backup` with a `freshness` block, or add
   a dedicated `GET /api/admin/backup-health` that #3/#6 call? (Prefer the latter — a stable,
   single-purpose endpoint for the two consumers.)
7. **Immutability / legal hold** on the container (ransomware resistance) — in scope now or
   later?
8. **Cross-region redundancy**: is GRS/geo-redundant storage wanted, or is LRS in one region
   enough for these dumps?

---

## 8. Ordered implementation task breakdown

*(Spec only — no code written. This is the build order for a later session.)*

**Phase 1 — restore drill + freshness (pre-migration, local-only, ship first):**
1. `sanitizeError` hardening — add SAS/`AccountKey`/connection-string redaction + tests.
   (Isolated, do first; every later `az` call depends on it.)
2. `backup-freshness.ts` — pure `backupFreshness(db)` derivation + unit tests + truth table.
3. `restore-drill.ts` — `RestoreDrillResult`, `drillDue`, `sweepRestoreDrill`; scratch-DB
   create→restore(reuse restore.sh semantics)→assert→`finally`-drop; integrity assertions
   (schema, key-table row counts, canary, orphan check). Unit-test `drillDue`; integration-
   test against a local dump incl. the **negative** (bad-dump-must-fail) case.
4. Staleness alert (">26h no backup") via `fireNotification(backupFailed)`.
5. Wire `sweepRestoreDrill` into `runner-service.ts:476` (append one line).
6. Admin/status surface: extend the route + card with drill status + freshness; new drill
   AppSetting `backup.azure.drill`. Verify with the web-dev-verify recipe.

**Phase 2 — Azure Blob off-box upload (at/after cutover):**
7. `backup-blob.ts` — `az`-CLI upload/download + `Content-MD5` checksum helpers, auth via
   managed identity or Delinea-brokered SAS (`credentialRef`); redact via §1. Unit-test path
   derivation + checksum.
8. Extend `runDbBackup` — post-verify upload; extend `DbBackupResult` with blob fields;
   upload failure ⇒ audit + alert but not a failed backup.
9. Switch the drill to prefer the Blob copy (download→checksum→restore) when Azure enabled.
10. Provisioning runbook + `azure/lifecycle-policy.json`: create account/container, RBAC /
    managed identity, apply lifecycle policy, set `backup.azure.*` AppSettings, flip
    `enabled`. End-to-end validate on the VM (upload, checksum round-trip, drill-from-Blob,
    lifecycle age-out).
11. Standalone `backup.sh` — add the same `az storage blob upload` call so the launchd layer
    also lands off-box (keep in step with the in-app path, as it is for `pg_dump`).

---

## Summary

- **Approach**: reuse the proven PR #26 dump machinery unchanged; bolt on two additive
  pieces — off-box upload to Azure Blob after each verified dump, and a scheduled
  restore-drill that restores the latest dump into a throwaway scratch DB, asserts integrity
  (schema, key-table row counts, a canary join, orphan check), tears the scratch DB down, and
  alerts on any failure. Both no-op safely with no Azure config, so nothing regresses before
  the migration.
- **Azure upload mechanism chosen**: **`az` CLI via `execFile`** (not the `@azure/storage-blob`
  SDK), for symmetry with the existing `execFile(pg_dump…)` shell-out, one tool the deploy
  already installs, and auth reuse (managed identity `--auth-mode login`); the SDK's
  `BlockBlobClient.uploadFile` is documented as the escape hatch if dumps grow large. Cited
  Context7 `/websites/learn_microsoft_en-us_azure_storage` (Azure Storage docs, 2026-07 fetch)
  for the upload command, auth options, and lifecycle-policy command.
- **Secrets**: dumps at rest confirmed to hold only Delinea *references* (`Secret.externalId`
  = "NEVER a value") and scrypt hashes — no plaintext creds. The Storage credential is never
  hardcoded: managed identity preferred (no secret at all), else a Delinea-brokered SAS via
  `backup.azure.credentialRef`; `sanitizeError` extended to redact SAS/keys.
- **Riskiest open question**: managed-identity-only vs also shipping a Delinea-SAS path for
  the transition window — it decides whether off-box upload works *before* the Azure move or
  only *after* it.
- **Shared files touched**: `web/lib/jobs/db-backup.ts` (extend), `runner-service.ts:476`
  (append one `sweepRestoreDrill` line — the shared pulse), the admin route +
  `db-backup-card.tsx` (additive status), `notifications/types.ts` only if the optional
  `restoreDrillFailed` event is adopted; new non-colliding files `restore-drill.ts`,
  `backup-blob.ts`, `backup-freshness.ts`, `azure/lifecycle-policy.json`. Web-only — no
  runner bump, no Prisma migration.
