# Database backup & restore

Nightly restorable backups of the iam-engine PostgreSQL database (`automationUM`).
Dumps are compressed custom-format archives (`pg_dump -Fc`), verified readable
after every run, rotated after 30 days, with a `latest.dump` symlink always
pointing at the newest snapshot.

## One-time setup

```sh
brew install libpq                       # pg_dump / pg_restore / psql clients
web/scripts/db-backup/install-schedule.sh --run-now
```

That installs a launchd agent (`com.coretelligent.iam-db-backup`) that runs
every night at **02:00** and takes one backup immediately. launchd fires a
missed run once when the Mac wakes, so the machine only needs to be powered on
at some point after 2 AM — not awake at exactly 2 AM.

- Backups land in `~/Backups/iam-engine/` (`--backup-dir` to change)
- Retention is 30 days (`--keep-days`); at ~a few MB per dump this is cheap
- Run log: `~/Backups/iam-engine/backup.log`
- The installer copies `backup.sh` + the connection string to
  `~/.local/share/iam-engine/db-backup/` (config is `chmod 600`), so the
  schedule keeps working even if the repo checkout moves. **Re-run the
  installer after editing `backup.sh` or rotating the DB password.**
- Remove everything: `install-schedule.sh --uninstall`

## Taking a backup manually

```sh
web/scripts/db-backup/backup.sh
```

Reads `DATABASE_URL` from `web/.env` by default; override with
`--database-url`, `--env-file`, `--backup-dir`, `--keep-days`.

## Restoring

**Safe inspection restore (default)** — restores into a brand-new scratch
database (`automationUM_restore_<timestamp>`) and never touches the live one:

```sh
web/scripts/db-backup/restore.sh                  # latest.dump
web/scripts/db-backup/restore.sh ~/Backups/iam-engine/automationUM-20260713-020000.dump
```

Point `psql`/Prisma at the scratch DB to inspect or copy rows back, then drop
it (the script prints the exact commands).

**Full disaster recovery** — drop the live database and restore the dump over
it. Stop the web app first, then:

```sh
web/scripts/db-backup/restore.sh --replace        # asks you to type the DB name
```

`--yes` skips the confirmation (for scripted recovery only). After a replace,
restart `next dev`/the web supervisor so Prisma reconnects.

## Notes

- The dump captures **all data and schema in the database** (every table,
  index, sequence value) — a restore reproduces the DB exactly as of the
  snapshot. Server-level objects (roles) are not included; those are part of
  the DB server's own provisioning.
- These backups run on whatever machine installed the schedule and store to
  its local disk. That protects against the main failure mode (a bad
  migration/reset wiping the shared DB) but not against that machine dying —
  for real durability, point `--backup-dir` at a synced/backed-up folder
  (e.g. a Drive/iCloud-synced path) or install the schedule on a second
  machine too. Multiple installs are harmless; dumps are read-only.
- Never run `prisma migrate dev` / `prisma migrate reset` against the shared
  DB — that is what these backups exist to recover from, not a workflow.
