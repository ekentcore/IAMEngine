"use client";

import { useState } from "react";
import type { Playbook } from "@/lib/cases/playbook";

const PRE: React.CSSProperties = {
  background: "#f6f8fa", border: "1px solid #e5e7eb", borderRadius: 4, padding: "0.6rem",
  overflowX: "auto", fontSize: 11, lineHeight: 1.45, margin: "0.25rem 0 0",
};

// The pre-flight, dry-run picture of a planned case: ordered steps, each expandable to the real
// script (resolved values) + the post-action checks. Nothing here executes.
export function PlaybookView({ playbook, caseId }: { playbook: Playbook; caseId: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (n: number) => setOpen((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });

  return (
    <div>
      <div className="row-between" style={{ alignItems: "baseline" }}>
        <p className="note" style={{ margin: 0 }}>
          {playbook.steps.length} steps, in order — dry run, nothing executes.
        </p>
        <div className="toolbar">
          <a href={`/api/cases/${caseId}/playbook?format=md`} download className="note">download .md →</a>
        </div>
      </div>
      {playbook.steps.map((s) => {
        const isOpen = open.has(s.seq);
        const auto = s.mode === "api";
        return (
          <details key={s.seq} open={isOpen} style={{ margin: "0.2rem 0" }}>
            <summary onClick={(e) => { e.preventDefault(); toggle(s.seq); }} style={{ cursor: "pointer" }}>
              <strong style={{ marginRight: 6 }}>{s.seq}.</strong>
              <span className="badge">{s.mode}</span> {s.systemName} <span className="note">({s.systemKey})</span>
              {s.requiresApproval && <span className="badge archived" style={{ marginLeft: 6 }}>approval</span>}
              {s.dependsOn.length > 0 && <span className="note" style={{ marginLeft: 6 }}>· after: {s.dependsOn.join(", ")}</span>}
            </summary>
            <div style={{ margin: "0.4rem 0 0.6rem 0.8rem" }}>
              {s.secretNames.length > 0 && <div className="note">Secrets: {s.secretNames.join(", ")}</div>}
              {auto && s.willRun ? (
                <>
                  <div className="note">Will run (PowerShell):</div>
                  <pre style={PRE}><code>{s.willRun}</code></pre>
                </>
              ) : (
                <div className="muted">{s.manualText ?? "Manual / checklist step."}</div>
              )}
              {s.validates.length > 0 && (
                <div style={{ marginTop: "0.5rem" }}>
                  <div className="note">Validates after running:</div>
                  <ul className="muted" style={{ margin: "0.2rem 0 0" }}>
                    {s.validates.map((v, i) => <li key={i}>{v}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
