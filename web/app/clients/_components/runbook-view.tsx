"use client";

import { useState } from "react";

export type RunbookItemVM = {
  id: string; // `${action}-${seq}`
  action: "onboard" | "offboard";
  status: string; // automated | manual | unmodeled
  systemKey: string | null;
  title: string;
  guess: string | null;
  steps: string[];
  after: string[]; // dependency system keys present in this action
  kbHref: string | null;
  kbNum: string | null;
  code: string | null; // intended-automation PowerShell preview
};

export function RunbookView({ items }: { items: RunbookItemVM[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setAll = (ids: string[], on: boolean) =>
    setOpen((s) => { const n = new Set(s); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; });

  return (
    <>
      {(["onboard", "offboard"] as const).map((action) => {
        const group = items.filter((i) => i.action === action);
        if (group.length === 0) return null;
        const ids = group.map((i) => i.id);
        const auto = group.filter((i) => i.status === "automated").length;
        const kb = group.find((i) => i.kbHref);
        return (
          <div key={action} style={{ marginTop: "1rem" }}>
            <div className="row-between" style={{ alignItems: "baseline" }}>
              <h3 style={{ margin: 0 }}>{action === "onboard" ? "Onboard" : "Offboard"}</h3>
              <div className="toolbar">
                {kb?.kbHref && (
                  <a href={kb.kbHref} target="_blank" rel="noreferrer" className="note">KB article {kb.kbNum} →</a>
                )}
                <button onClick={() => setAll(ids, true)}>Expand all</button>
                <button onClick={() => setAll(ids, false)}>Collapse all</button>
              </div>
            </div>
            <p className="note" style={{ marginTop: 0 }}>
              {group.length} steps — {auto} automated, {group.length - auto} human interaction
            </p>
            {group.map((it, idx) => (
              <Item key={it.id} it={it} n={idx + 1} open={open.has(it.id)} onToggle={() => toggle(it.id)} />
            ))}
          </div>
        );
      })}
    </>
  );
}

function Item({ it, n, open, onToggle }: { it: RunbookItemVM; n: number; open: boolean; onToggle: () => void }) {
  const auto = it.status === "automated";
  const badge = auto ? "✅ Automated" : it.status === "manual" ? "✋ Human · manual" : "✋ Human · needs module";
  const title = it.systemKey ? `${it.systemKey} — ${it.title}` : it.guess ? `${it.title} (${it.guess})` : it.title;
  return (
    <details open={open} style={{ margin: "0.2rem 0" }}>
      <summary onClick={(e) => { e.preventDefault(); onToggle(); }} style={{ cursor: "pointer" }}>
        <strong style={{ marginRight: 6 }}>{n}.</strong>
        <span className={`badge ${auto ? "automated" : "human"}`}>{badge}</span> {title}
        {it.after.length > 0 && <span className="note" style={{ marginLeft: 6 }}>· after: {it.after.join(", ")}</span>}
      </summary>
      <div style={{ margin: "0.4rem 0 0.6rem" }}>
        {it.steps.length === 0 ? (
          <p className="note" style={{ marginLeft: "1rem" }}>(no step text — see the KB article)</p>
        ) : (
          it.steps.map((step, i) => {
            const indent = step.match(/^ */)?.[0].length ?? 0;
            return <div key={i} className="muted" style={{ marginLeft: `${0.8 + indent * 0.6}rem` }}>• {step.trim()}</div>;
          })
        )}
        {it.code && (
          <div style={{ marginTop: "0.5rem", marginLeft: "0.8rem" }}>
            <div className="note">Intended automation (PowerShell):</div>
            <pre style={{ background: "#f6f8fa", border: "1px solid #e5e7eb", borderRadius: 4, padding: "0.6rem", overflowX: "auto", fontSize: 11, lineHeight: 1.45, margin: "0.25rem 0 0" }}>
              <code>{it.code}</code>
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
