"use client";

// Author the targets a location adds to a hire: AD/365 groups (picked from the client's discovered
// groups) plus free-text printer names. Groups union into the directory jobs at plan time; printers
// become a manual "Map printers at <location>" checklist step (plan-resolve). Saves on any change.
import { useState } from "react";
import { TagList } from "./condition-builder";
import { GroupMultiselect } from "./group-multiselect";

export function LocationTargetsEditor({ slug, name, groups, printers, sections }: {
  slug: string;
  name: string;
  groups: string[];
  printers: string[];
  sections: { label: string; options: string[] }[];
}) {
  const [g, setG] = useState<string[]>(groups);
  const [p, setP] = useState<string[]>(printers);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  async function save(nextGroups: string[], nextPrinters: string[]) {
    setG(nextGroups); setP(nextPrinters); setErr(null);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-location-targets", name, groups: nextGroups, printers: nextPrinters }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setErr(d.error ?? `failed (${r.status})`); return; }
      setSavedAt(Date.now());
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="location-targets">
      <div className="lt-box lt-groups">
        <div className="lt-label">Groups (AD / 365)</div>
        <GroupMultiselect
          sections={sections}
          value={g}
          onChange={(next) => save(next, p)}
          emptyHint="No groups discovered yet — refresh AD / cloud groups on this page."
        />
      </div>
      <div className="lt-box lt-printers">
        <div className="lt-label">Printers</div>
        <TagList items={p} onChange={(next) => save(g, next)} placeholder="printer name…" />
      </div>
      <div className="lt-status">
        {err ? <span className="note" style={{ color: "#b3261e" }}>{err}</span>
          : savedAt ? <span className="note muted">saved</span> : null}
      </div>
    </div>
  );
}
