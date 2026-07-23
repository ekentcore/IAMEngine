import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "backup-azure-restore-drill",
  date: "2026-07-22",
  time: "23:45",
  title: "Backups: a weekly restore drill that proves dumps are restorable, plus off-box Azure copies",
  items: [
    "New scheduled restore drill (default on, weekly): it restores the latest database dump into a throwaway scratch database, checks it for integrity - the schema matches live, the key tables came back with rows, a canary join returns data, and no foreign keys are orphaned - then drops the scratch database. A backup you have never restored is not a backup",
    "A drill that fails - a corrupt, truncated, or empty dump - fires a loud \"backup failed\" notification and is recorded, instead of a bad backup sitting undiscovered until the day you need it. The drill can never touch the live database (it always uses an isolated scratch copy and refuses to run otherwise)",
    "New \"are backups fresh and restorable?\" signal on the settings backup card: it turns red when the last successful dump is over 26 hours old (or never ran), when the restore drill has not passed recently, or when the off-box copy is missing - and a \">26h with no backup\" alert now fires even when nothing ran at all to fail",
    "Off-box durable copies to Azure Blob Storage are BUILT but SHIP DARK - disabled by default, nothing reaches Azure until an operator switches it on at the cloud cutover. When enabled, each verified dump is uploaded with an end-to-end checksum; an upload failure alerts but never fails the local backup",
    "Azure credentials are always a reference, never a stored value: a managed identity (no secret at all) is preferred, with a Delinea-brokered SAS as the fallback. Error and log output now scrubs SAS tokens and account keys the same way it already scrubbed the database password",
  ],
};
