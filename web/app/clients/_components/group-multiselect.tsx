"use client";
import { useState } from "react";

// Sectioned, searchable multi-select over a client's discovered AD + 365 groups.
// Sections come pre-bucketed by type (365 Distribution / 365 Security / 365 Groups / AD).
// A selected value that no longer appears in any section (e.g. deleted upstream) is still
// shown as a removable chip so it is never silently dropped from `value`.
export function GroupMultiselect({ sections, value, onChange, emptyHint }: {
  sections: { label: string; options: string[] }[];
  value: string[];
  onChange: (next: string[]) => void;
  emptyHint?: string;
}) {
  const [q, setQ] = useState("");
  const selected = new Set(value);

  // Dedupe option names across sections (first occurrence wins).
  const seen = new Set<string>();
  const cleanSections = sections.map((s) => ({
    label: s.label,
    options: s.options.filter((o) => o && !seen.has(o) && (seen.add(o), true)),
  }));

  const needle = q.trim().toLowerCase();
  const filtered = cleanSections
    .map((s) => ({ label: s.label, options: s.options.filter((o) => o.toLowerCase().includes(needle)) }))
    .filter((s) => s.options.length > 0);

  const allEmpty = cleanSections.every((s) => s.options.length === 0);

  const toggle = (name: string) => {
    const next = selected.has(name) ? value.filter((v) => v !== name) : [...value, name];
    onChange(next);
  };

  return (
    <div className="group-multiselect">
      {value.length > 0 && (
        <div className="gm-chips">
          {value.map((c) => (
            <button key={c} type="button" className="gm-chip" onClick={() => toggle(c)} title="remove">
              {c} <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      )}
      <input
        className="gm-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search groups…"
      />
      {allEmpty ? (
        <div className="note muted">{emptyHint ?? "No groups discovered yet."}</div>
      ) : (
        <div className="gm-list">
          {filtered.length === 0 ? (
            <div className="note muted">No match.</div>
          ) : (
            filtered.map((s) => (
              <div key={s.label} className="gm-section">
                <div className="gm-section-label">{s.label}</div>
                {s.options.map((o) => (
                  <label key={o} className="gm-option">
                    <input type="checkbox" checked={selected.has(o)} onChange={() => toggle(o)} />
                    <span>{o}</span>
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
