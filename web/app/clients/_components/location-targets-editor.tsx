"use client";

// Author the AD/Entra groups a location adds to a hire (e.g. Boston → FalconBOS + the floor-printer
// group). Chips with suggestions from the client's discovered AD/cloud groups; saves on change. The
// plan engine (plan-resolve) unions these into the directory jobs when a hire matches this location.
import { useState } from "react";
import { TagList } from "./condition-builder";

export function LocationTargetsEditor({ slug, name, groups, groupOptions }: { slug: string; name: string; groups: string[]; groupOptions: string[] }) {
  const [g, setG] = useState<string[]>(groups);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  async function save(next: string[]) {
    setG(next); setErr(null);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-location-targets", name, groups: next }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setErr(d.error ?? `failed (${r.status})`); return; }
      setSavedAt(Date.now());
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div style={{ minWidth: 220 }}>
      <TagList items={g} onChange={save} placeholder="group / printer…" options={groupOptions} />
      {err ? <div className="note" style={{ color: "#b3261e" }}>{err}</div>
        : savedAt ? <div className="note muted">saved</div> : null}
    </div>
  );
}
