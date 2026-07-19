"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Shown on a held "change" (mover) case awaiting a removal-mode decision: per-system adds/removes the
// rule engine derived from the persona swap, plus the scoped/full/add-only choice that decides how far
// the removal reaches at run time. Confirming releases the case's review hold and plans it.
type Diff = { systemKey: string; add: string[]; removeGroups: string[]; moveToOu?: string };
type Props = { caseId: string; diffs: Diff[] };

export function ChangePreview({ caseId, diffs }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"scoped" | "full" | "add-only">("scoped");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/change/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removalMode: mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) router.refresh();
      else setError(data.error ?? res.statusText);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <h3>Review the change</h3>
      {diffs.map((d) => (
        <div key={d.systemKey}>
          <strong>{d.systemKey}</strong>
          <ul style={{ margin: "4px 0" }}>
            {d.add.map((g) => (
              <li key={`a-${g}`} style={{ color: "var(--ok-fg)" }}>
                + add {g}
              </li>
            ))}
            {mode !== "add-only" &&
              d.removeGroups.map((g) => (
                <li key={`r-${g}`} style={{ color: "var(--err-fg)" }}>
                  − remove {g}
                </li>
              ))}
            {mode === "full" && (
              <li className="note">
                + full reconciliation: any group not required by the new role will also be removed at run time
                (protected groups excluded).
              </li>
            )}
            {d.moveToOu && (
              <li style={{ color: "var(--ok-fg)" }}>
                → move to OU: <code>{d.moveToOu}</code>
              </li>
            )}
            {d.add.length === 0 && !d.moveToOu && (mode === "add-only" || d.removeGroups.length === 0) && (
              <li className="note">no change</li>
            )}
          </ul>
        </div>
      ))}
      <fieldset>
        <legend>Removal scope</legend>
        <label style={{ display: "block" }}>
          <input type="radio" name="removal-mode" checked={mode === "scoped"} onChange={() => setMode("scoped")} disabled={busy} /> Scoped — only
          groups the old role managed
        </label>
        <label style={{ display: "block" }}>
          <input type="radio" name="removal-mode" checked={mode === "full"} onChange={() => setMode("full")} disabled={busy} /> Full reconciliation —
          remove anything not in the new role
        </label>
        <label style={{ display: "block" }}>
          <input type="radio" name="removal-mode" checked={mode === "add-only"} onChange={() => setMode("add-only")} disabled={busy} /> Add only — never
          remove
        </label>
      </fieldset>
      {error && <p className="note danger">{error}</p>}
      <div className="toolbar" style={{ justifyContent: "flex-end" }}>
        <button className="primary" onClick={confirm} disabled={busy}>
          {busy ? "Applying…" : "Confirm & plan"}
        </button>
      </div>
    </section>
  );
}
