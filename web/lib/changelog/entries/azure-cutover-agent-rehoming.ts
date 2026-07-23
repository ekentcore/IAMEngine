import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "azure-cutover-agent-rehoming",
  date: "2026-07-23",
  time: "00:45",
  title: "New Azure cutover console — a guided, verified, reversible move of the brain off the Mac",
  items: [
    "Added a guided cutover console at /cutover (More → Administration → Azure cutover, gated on manage-settings) that sequences the whole move to Azure on one screen: stage the new URL → drain in-flight work → push the fleet → watch every agent re-home on a live green/red board → verify the database → confirm or roll back",
    "It reuses the machinery you already have rather than inventing anything: pushing to the fleet just writes the existing agent-migration setting that the heartbeat already turns into a move directive (no runner change), draining calls the existing maintenance/drain, and the re-home board reads the same per-agent migration signal as Fleet health — an agent goes green only when it reports back in on the Azure URL",
    "Database-move verification proves the Postgres move was lossless without any cross-origin call: a baseline (row counts for every table + a hash of every Secret→Delinea reference) is written into the database before the dump so it travels inside pg_dump, then recounted and diffed after the restore on Azure; a table that lost rows, or a changed secret-reference set, fails the check",
    "The verification also samples whether secrets still resolve FROM the new Azure host — and if Delinea isn't reachable from Azure (no egress or broker account, the one infra unknown for the move) the check reports red/unknown and blocks confirmation rather than pretending success",
    "Reversible and split-brain-safe by construction: rollback points the fleet back at the Mac (symmetric re-home, verified reachable first), the old app stays up as a redirect lighthouse so offline stragglers re-home when they surface, and cutover never confirms until every agent is green (or offline stragglers are explicitly acknowledged) AND the database verifies",
    "All cutover state lives in one app-settings record — no database migration the night of the move — and every transition is audited and race-safe against two operators acting at once",
  ],
};
