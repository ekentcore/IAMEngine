"use client";

// Nightly database backup: status + enable toggle + "Back up now". The backup itself runs
// in-app off the heartbeat sweep (lib/jobs/db-backup.ts); this card is the operator surface.
import { useState } from "react";
import { formatDateTime } from "@/lib/dates";
import type { DbBackupStatus } from "@/lib/jobs/db-backup";

export type { DbBackupStatus };

function fmtSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function DbBackupCard({ initial }: { initial: DbBackupStatus }) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState<"toggle" | "run" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, kind: "toggle" | "run") {
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
        result?: DbBackupStatus["lastResult"];
      };
      if (!r.ok && !d.result) {
        setErr(d.error ?? `failed (${r.status})`);
        return;
      }
      setStatus((s) => ({
        ...s,
        ...(typeof d.enabled === "boolean" ? { enabled: d.enabled } : {}),
        ...(d.result ? { lastResult: d.result } : {}),
      }));
      if (d.result && !d.result.ok) setErr(d.result.error ?? "backup failed");
    } catch {
      setErr("request failed");
    } finally {
      setBusy(null);
    }
  }

  const last = status.lastResult;
  return (
    <section style={{ marginTop: "2.5rem" }}>
      <h2>Database backups</h2>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        A full <code>pg_dump</code> of the database is taken on the first activity pulse after{" "}
        {String(status.hourLocal).padStart(2, "0")}:00 each night (the pulse rides runner heartbeats — with
        every runner offline, no in-app backup runs), verified, and kept for {status.keepDays} days in{" "}
        <code>{status.backupDir}</code>. Restore with <code>web/scripts/db-backup/restore.sh</code> (safe
        scratch-database restore by default). If a backup fails, a &ldquo;backup failed&rdquo; notification fires.
      </p>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        {last ? (
          last.ok ? (
            <>
              Last backup: <b>{formatDateTime(last.at)}</b> — {fmtSize(last.sizeBytes)},{" "}
              {last.dataTables ?? "?"} tables, verified.
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
            checked={status.enabled}
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
      {err && (
        <p className="note" style={{ color: "#b3261e", marginTop: 4 }}>
          {err}
        </p>
      )}
    </section>
  );
}
