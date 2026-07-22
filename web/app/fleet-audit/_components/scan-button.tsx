"use client";

// "Run scan" + the live progress line. A sweep takes minutes, so the button starts it and this polls
// the run's state; when it finishes we refresh the server component to pick up the new findings.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Run = { status: string; scanned: number; total: number; error: string | null; finishedAt: string | null } | null;

export function ScanButton({ kind, initial }: { kind: "permissions" | "leaked_seats" | "escalation_holders"; initial: Run }) {
  const router = useRouter();
  const [run, setRun] = useState<Run>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const running = run?.status === "running";

  useEffect(() => {
    if (!running) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/fleet-audit/${kind}`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const d = (await res.json()) as { run: Run };
        if (!alive) return;
        setRun(d.run);
        // Finished: pull the findings in via the server component rather than re-fetching them here.
        if (d.run && d.run.status !== "running") router.refresh();
      } catch { /* a dropped poll is not worth surfacing — the next tick retries */ }
    }, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [running, kind, router]);

  async function start() {
    setBusy(true); setNote(null);
    try {
      const res = await fetch(`/api/fleet-audit/${kind}`, { method: "POST" });
      const d = (await res.json()) as { started?: boolean; reason?: string };
      if (res.status === 409) setNote(d.reason ?? "a scan is already running");
      else if (!res.ok) setNote("could not start the scan");
      setRun({ status: "running", scanned: 0, total: 0, error: null, finishedAt: null });
    } catch {
      setNote("could not start the scan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <button onClick={start} disabled={busy || running}>
        {running ? "Scanning…" : "Run scan"}
      </button>
      {running && (
        <span className="muted" style={{ fontSize: 12 }}>
          {run!.total ? `${run!.scanned} / ${run!.total} clients` : "starting…"} — this takes a few minutes
        </span>
      )}
      {run?.status === "failed" && <span style={{ fontSize: 12, color: "#b45309" }}>last scan failed: {run.error}</span>}
      {note && <span style={{ fontSize: 12, color: "#b45309" }}>{note}</span>}
    </span>
  );
}
