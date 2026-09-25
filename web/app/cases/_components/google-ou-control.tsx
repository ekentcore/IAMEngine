"use client";

// Per-case Google Workspace OU (FR #81): where this user is created (onboard) or moved (offboard).
// Saves through the case fields route as googleOu / googleInactiveOu — marked operator-sourced so a
// ServiceNow re-pull keeps it — and that route re-plans, which puts the OU on the Google job.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { checkGoogleOu, GOOGLE_OU_FIELD } from "@/lib/profiles/google-ou";

export function GoogleOuControl({ caseId, action, current, overridden, locked, canEdit, options = [] }: {
  caseId: string;
  action: "onboard" | "offboard";
  current: string; // the OU the planned Google job will use now
  overridden: boolean; // true when this case already carries its own pick
  locked: boolean; // the Google step already ran — a new OU would change nothing
  canEdit: boolean; // the viewer may edit case fields (case.dispatch, the fields route gate)
  options?: string[]; // the tenant's OU paths, if discovered (FR #81) — suggestions for the input
}) {
  const router = useRouter();
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const field = GOOGLE_OU_FIELD[action];
  const label = action === "onboard" ? "Create the Google user in OU" : "Move the Google user to OU";

  async function save(next: string) {
    const checked = next === "" ? { ok: true as const, ou: "" } : checkGoogleOu(next);
    if (!checked.ok) { setMsg({ ok: false, text: checked.error }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/cases/${caseId}/fields`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { [field]: checked.ou } }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      // The fields route only re-plans a case nothing has run on yet. On a started case the OU is saved
      // but the Google job still holds the old one — re-plan explicitly (it keeps every step that ran).
      if (d.replanned == null) {
        const rp = await fetch(`/api/cases/${caseId}/replan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (!rp.ok) {
          const e = await rp.json().catch(() => ({}));
          setMsg({ ok: false, text: `saved, but the re-plan failed: ${e.error ?? rp.status} — use Re-plan in the Actions menu` });
          router.refresh();
          return;
        }
      }
      setMsg({ ok: true, text: checked.ou ? "Saved — the case was re-planned." : "Cleared — back to the client's OU." });
      router.refresh();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "0.4rem 0" }}>
      <span className="note" style={{ margin: 0 }}>{label}</span>
      <input value={value} onChange={(e) => { setValue(e.target.value); setMsg(null); }} disabled={busy || locked || !canEdit}
        placeholder={action === "onboard" ? "/Active Users" : "/Email & Calendar/Inactive"} list={`google-ou-${caseId}`}
        style={{ fontFamily: "monospace", fontSize: 12, minWidth: 260, width: "auto" }} />
      <button onClick={() => save(value)} disabled={busy || locked || !canEdit || value.trim() === current}>{busy ? "Saving…" : "Save"}</button>
      {overridden && !locked && canEdit && <button onClick={() => save("")} disabled={busy} title="Use the client's OU for this case">Use client default</button>}
      <datalist id={`google-ou-${caseId}`}>{options.map((o) => <option key={o} value={o} />)}</datalist>
      {locked && <span className="note">The Google step already ran on this case.</span>}
      {msg && <span className="note" style={{ color: msg.ok ? undefined : "#b3261e" }}>{msg.text}</span>}
    </div>
  );
}
