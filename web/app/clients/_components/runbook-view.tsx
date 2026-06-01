"use client";

import { useState } from "react";
import type { KbRef, RunbookItem } from "@/lib/clients/types";

type Props = {
  action: "onboard" | "offboard";
  items: RunbookItem[];
  kb: KbRef | null;
};

const TITLE = { onboard: "Onboarding runbook", offboard: "Offboarding runbook" } as const;

export function RunbookView({ action, items, kb }: Props) {
  const keyOf = (i: RunbookItem) => `${action}-${i.seq}`;
  const [open, setOpen] = useState<Set<string>>(new Set());

  const expandAll = () => setOpen(new Set(items.map(keyOf)));
  const collapseAll = () => setOpen(new Set());
  const toggle = (key: string, isOpen: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (isOpen) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>{TITLE[action]}</h2>
        {kb?.url && (
          <a href={kb.url} target="_blank" rel="noreferrer" style={{ fontSize: ".9rem" }}>
            View KB article ({kb.number}) →
          </a>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={expandAll} style={btn}>Expand all</button>
        <button type="button" onClick={collapseAll} style={btn}>Collapse all</button>
      </div>

      {items.length === 0 && <p style={{ color: "#666" }}>No steps for this action.</p>}

      <ol style={{ listStyle: "none", padding: 0, margin: ".75rem 0 0" }}>
        {items.map((item) => {
          const key = keyOf(item);
          const isOpen = open.has(key);
          return (
            <li key={key} style={{ borderTop: "1px solid #eee", padding: ".25rem 0" }}>
              <details open={isOpen} onToggle={(e) => toggle(key, e.currentTarget.open)}>
                <summary style={{ cursor: "pointer", listStyle: "none" }}>
                  <span style={{ color: "#888", marginRight: ".5rem" }}>{item.stepNumber}.</span>
                  <span style={{ fontWeight: 600 }}>{item.systemName}</span>
                  <span style={{ marginLeft: ".5rem" }}>{item.automated ? "✅ Automated" : "✋ Human"}</span>
                  {item.when === "on_request" && <span style={badge}>on request</span>}
                  {item.dependsOn.length > 0 && (
                    <span style={{ ...badge, color: "#555" }}>after: {item.dependsOn.join(", ")}</span>
                  )}
                </summary>

                <div style={{ padding: ".5rem 0 .5rem 1.5rem" }}>
                  {item.steps.length > 0 ? (
                    <ul style={{ margin: 0 }}>
                      {item.steps.map((s, idx) => (
                        <li key={idx}>{s}</li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ color: "#666", margin: 0 }}>No configured detail.</p>
                  )}

                  {item.codePreview && (
                    <pre style={pre}>
                      <code>{item.codePreview}</code>
                    </pre>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const btn: React.CSSProperties = {
  border: "1px solid #ccc",
  background: "#fff",
  padding: ".25rem .6rem",
  fontSize: ".85rem",
  cursor: "pointer",
};

const badge: React.CSSProperties = {
  marginLeft: ".5rem",
  fontSize: ".75rem",
  color: "#777",
  border: "1px solid #ddd",
  borderRadius: "3px",
  padding: "0 .35rem",
};

const pre: React.CSSProperties = {
  marginTop: ".75rem",
  padding: ".75rem",
  background: "#f6f8fa",
  border: "1px solid #e1e4e8",
  borderRadius: "4px",
  overflowX: "auto",
  fontSize: ".8rem",
  lineHeight: 1.5,
};
