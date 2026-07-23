"use client";

// Nightly database backup + restore drill: status + enable toggle + "Back up now" / "Run drill now".
// The backup and the weekly restore drill both run in-app off the heartbeat sweep (lib/jobs/db-backup.ts,
// lib/jobs/restore-drill.ts); this card is the operator surface. The freshness banner is the same
// derived signal features #3/#6 consume.
import { useState } from "react";
import { formatDateTime } from "@/lib/dates";
import type { DbBackupStatus } from "@/lib/jobs/db-backup";
import type { RestoreDrillStatus } from "@/lib/jobs/restore-drill";
import type { BackupFreshness } from "@/lib/jobs/backup-freshness";

export type DbBackupCardLoad = { backup: DbBackupStatus; drill: RestoreDrillStatus; freshness: BackupFreshness };

function fmtSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function DbBackupCard({ initial }: { initial: DbBackupCardLoad }) {
  const [backup, setBackup] = useState(initial.backup);
  const [drill, setDrill] = useState(initial.drill);
  const [fresh] = useState(initial.freshness);
  const [busy, setBusy] = useState<"toggle" | "run" | "drillToggle" | "drill" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, kind: NonNullable<typeof busy>) {
    setBusy(kind);
    setErr(null);
    try {
      const r = await fetch("/api/admin/db-backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => ({}))) as {
        error?: string;
        enabled?: boolean;
        drillEnabled?: boolean;
        result?: DbBackupStatus["lastResult"];
        drillResult?: RestoreDrillStatus["lastResult"];
      };
      if (!r.ok && !d.result && !d.drillResult) {
        setErr(d.error ?? `failed (${r.status})`);
        return;
      }
      if (typeof d.enabled === "boolean") setBackup((s) => ({ ...s, enabled: d.enabled as boolean }));
      if (d.result) setBackup((s) => ({ ...s, lastResult: d.result ?? s.lastResult }));
      if (typeof d.drillEnabled === "boolean") setDrill((s) => ({ ...s, enabled: d.drillEnabled as boolean }));
      if (d.drillResult) setDrill((s) => ({ ...s, lastResult: d.drillResult ?? s.lastResult }));
      if (d.result && !d.result.ok) setErr(d.result.error ?? "backup failed");
      if (d.drillResult && !d.drillResult.ok) setErr(d.drillResult.error ?? "restore drill failed");
    } catch {
      setErr("request failed");
    } finally {
      setBusy(null);
    }
  }

  const last = backup.lastResult;
  const lastDrill = drill.lastResult;
  return (
    <section style={{ marginTop: "2.5rem" }}>
      <h2>Database backups</h2>

      {/* Freshness banner — the single "fresh and restorable?" signal. */}
      <p
        className="note"
        style={{ marginBottom: "0.75rem", color: fresh.healthy ? "#146c2e" : "#b3261e", fontWeight: 600 }}
      >
        {fresh.healthy
          ? "Backups are fresh and the latest dump was proven restorable."
          : fresh.backupStale
            ? "No fresh backup — the last successful dump is stale (over 26h old) or has never run."
            : fresh.drillStale
              ? "Backups are fresh, but the restore drill has not passed recently — restore path unproven."
              : !fresh.blobOk
                ? "The off-box (Azure Blob) copy is missing or stale."
                : "Backups need attention."}
      </p>

      <p className="note" style={{ marginBottom: "0.75rem" }}>
        A full <code>pg_dump</code> of the database is taken on the first activity pulse after{" "}
        {String(backup.hourLocal).padStart(2, "0")}:00 each night (the pulse rides runner heartbeats — with
        every runner offline, no in-app backup runs), verified, and kept for {backup.keepDays} days in{" "}
        <code>{backup.backupDir}</code>. Restore with <code>web/scripts/db-backup/restore.sh</code> (safe
        scratch-database restore by default). If a backup fails, a &ldquo;backup failed&rdquo; notification fires.
      </p>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        {last ? (
          last.ok ? (
            <>
              Last backup: <b>{formatDateTime(last.at)}</b> — {fmtSize(last.sizeBytes)},{" "}
              {last.dataTables ?? "?"} tables, verified.
              {last.uploadError ? (
                <span style={{ color: "#b3261e" }}> Off-box upload failed: {last.uploadError}</span>
              ) : last.blobUploadedAt ? (
                <span> Off-box copy in Azure Blob at {formatDateTime(last.blobUploadedAt)}.</span>
              ) : null}
            </>
          ) : (
            <span style={{ color: "#b3261e" }}>
              Last backup failed at {formatDateTime(last.at)}: {last.error}
            </span>
          )
        ) : (
          <>No backup has run yet — the first one is taken on the next sweep tick tonight.</>
        )}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={backup.enabled}
            disabled={busy !== null}
            onChange={(e) => post({ enabled: e.target.checked }, "toggle")}
            style={{ width: "auto" }}
          />
          Take a backup every night
        </label>
        <button type="button" disabled={busy !== null} onClick={() => post({ action: "run" }, "run")}>
          {busy === "run" ? "Backing up…" : "Back up now"}
        </button>
      </div>

      {/* Restore drill (feature #5). */}
      <h3 style={{ marginTop: "1.5rem", fontSize: 15 }}>Restore drill</h3>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        Every {DAYS[drill.dayOfWeek]} after {String(drill.hourLocal).padStart(2, "0")}:00 the latest dump is
        restored into a throwaway scratch database, checked for integrity (schema, key-table row counts, a
        canary join, and orphaned foreign keys), then dropped. A failed drill fires a &ldquo;backup
        failed&rdquo; notification — a backup you have never restored is not a backup.
      </p>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        {lastDrill ? (
          lastDrill.ok ? (
            <>
              Last drill: <b>{formatDateTime(lastDrill.at)}</b> — passed ({lastDrill.tables ?? "?"} tables,{" "}
              {lastDrill.source === "blob" ? "from Azure Blob" : "from local dump"}
              {typeof lastDrill.durationMs === "number" ? `, ${(lastDrill.durationMs / 1000).toFixed(0)}s` : ""}).
            </>
          ) : (
            <span style={{ color: "#b3261e" }}>
              Last drill FAILED at {formatDateTime(lastDrill.at)}: {lastDrill.error}
            </span>
          )
        ) : (
          <>No drill has run yet — the first one runs on its next weekly boundary.</>
        )}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={drill.enabled}
            disabled={busy !== null}
            onChange={(e) => post({ drillEnabled: e.target.checked }, "drillToggle")}
            style={{ width: "auto" }}
          />
          Run the restore drill weekly
        </label>
        <button type="button" disabled={busy !== null} onClick={() => post({ action: "drill" }, "drill")}>
          {busy === "drill" ? "Running drill…" : "Run drill now"}
        </button>
      </div>

      {err && (
        <p className="note" style={{ color: "#b3261e", marginTop: 4 }}>
          {err}
        </p>
      )}
    </section>
  );
}
