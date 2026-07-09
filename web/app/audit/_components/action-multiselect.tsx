"use client";

// Searchable checkbox multi-select for the audit action filter. Selecting multiple is an OR (the
// server queries action IN […]). Options are grouped, and each group has an "All <group>" checkbox
// (e.g. "All Login" toggles login + SSO login + failed login at once).
import { useEffect, useMemo, useRef, useState } from "react";

export type ActionOption = { key: string; label: string; group: string };

export function ActionMultiSelect({ options, selected, onChange }: {
  options: ActionOption[];
  selected: string[];
  onChange: (keys: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const sel = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, ActionOption[]>();
    for (const o of options) { if (!m.has(o.group)) m.set(o.group, []); m.get(o.group)!.push(o); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [options]);

  const ql = q.trim().toLowerCase();
  const matches = (o: ActionOption) => !ql || o.label.toLowerCase().includes(ql) || o.key.toLowerCase().includes(ql) || o.group.toLowerCase().includes(ql);

  const toggle = (key: string) => { const n = new Set(sel); n.has(key) ? n.delete(key) : n.add(key); onChange([...n]); };
  const toggleGroup = (members: ActionOption[]) => {
    const keys = members.map((m) => m.key);
    const all = keys.every((k) => sel.has(k));
    const n = new Set(sel);
    keys.forEach((k) => (all ? n.delete(k) : n.add(k)));
    onChange([...n]);
  };

  const buttonLabel = selected.length === 0 ? "All actions"
    : selected.length === 1 ? (options.find((o) => o.key === selected[0])?.label ?? "1 action")
    : `${selected.length} actions`;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" className="inline" onClick={() => setOpen((o) => !o)} title="Filter by one or more actions (OR)"
        style={{ minWidth: 130, textAlign: "left" }}>
        {buttonLabel} <span className="note">▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", zIndex: 30, top: "calc(100% + 2px)", left: 0, width: 280, maxHeight: 360, overflowY: "auto", background: "#fff", border: "1px solid var(--line, #ccc)", borderRadius: 6, boxShadow: "0 4px 14px rgba(0,0,0,0.16)", padding: 8 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="search actions…" style={{ flex: 1, fontSize: 12 }} />
          {selected.length > 0 && <button type="button" className="linklike" onClick={() => onChange([])}>clear</button>}
        </div>
        {groups.map(([g, members]) => {
          const vis = members.filter(matches);
          if (!vis.length) return null;
          const allOn = vis.every((m) => sel.has(m.key));
          return (
            <div key={g} style={{ marginBottom: 6 }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, fontWeight: 600, margin: 0 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={allOn} ref={(el) => { if (el) el.indeterminate = !allOn && vis.some((m) => sel.has(m.key)); }} onChange={() => toggleGroup(vis)} />
                All {g}
              </label>
              {vis.map((o) => (
                <label key={o.key} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, margin: 0, paddingLeft: 18, color: "var(--ink-2, #2b303b)" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={sel.has(o.key)} onChange={() => toggle(o.key)} />
                  {o.label}
                </label>
              ))}
            </div>
          );
        })}
        {groups.every(([, members]) => !members.some(matches)) && <div className="note" style={{ padding: 4 }}>no actions match.</div>}
        </div>
      )}
    </div>
  );
}
