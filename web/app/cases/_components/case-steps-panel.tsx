"use client";

// "Steps on this case" (FR #173 / #134): tick which of the client's systems run on this one case.
// Switching on an on-request step records that it was asked for (the runner has no other way to
// know); switching off a step skips it for this case only. Saving re-plans the case. Steps that
// already ran, or that an intake rule skips, can't be changed here and say why.
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { StepRow } from "@/lib/cases/case-steps";

const LANE_LABEL: Record<StepRow["lane"], string> = {
  always: "always",
  on_request: "on request",
  by_persona: "by persona",
};

export function CaseStepsPanel({ caseId, rows, canEdit }: { caseId: string; rows: StepRow[]; canEdit: boolean }) {
  const router = useRouter();
  const initial = new Set(rows.filter((r) => r.runs).map((r) => r.systemKey));
  const [want, setWant] = useState<Set<string>>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = rows.some((r) => want.has(r.systemKey) !== initial.has(r.systemKey));

  function toggle(key: string) {
    setWant((w) => { const n = new Set(w); if (n.has(key)) n.delete(key); else n.add(key); return n; });
    setMsg(null);
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/cases/${caseId}/steps`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ running: [...want] }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      setMsg({ ok: true, text: "Saved — the case was re-planned." });
      router.refresh();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  if (rows.length === 0) return <p className="note">This client has no systems for this action.</p>;

  return (
    <div>
      <p className="note" style={{ marginTop: 0 }}>
        Tick the steps this case needs. On-request steps only run when ticked here or asked for on the intake; unticking a step skips it for this case only. Steps that haven&rsquo;t run yet are re-planned when you save.
      </p>
      <table>
        <thead>
          <tr><th style={{ width: 28 }} aria-label="Runs"></th><th>Step</th><th>Client runs it</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const on = want.has(r.systemKey);
            const changed = on !== r.natural;
            return (
              <tr key={r.systemKey}>
                <td>
                  <input type="checkbox" checked={on} disabled={!canEdit || busy || !!r.locked} onChange={() => toggle(r.systemKey)}
                    aria-label={`Run ${r.systemKey} on this case`} style={{ width: "auto" }} />
                </td>
                <td>{r.systemKey}</td>
                <td className="muted">{LANE_LABEL[r.lane]}</td>
                <td className="note">
                  {r.locked ?? (changed
                    ? (on ? "requested for this case" : "skipped for this case")
                    : on && r.lane === "on_request" ? "requested on the intake"
                    : on && r.lane === "by_persona" ? "included by the persona"
                    : "")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canEdit && (
        <div className="toolbar" style={{ gap: 8, alignItems: "center" }}>
          <button className="primary" disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save and re-plan"}</button>
          {dirty && !busy && <button onClick={() => { setWant(initial); setMsg(null); }}>Reset</button>}
          {msg && <span className="note" style={{ color: msg.ok ? undefined : "#b3261e" }}>{msg.text}</span>}
        </div>
      )}
    </div>
  );
}
