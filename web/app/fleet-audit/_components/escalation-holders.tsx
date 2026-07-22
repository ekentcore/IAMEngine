"use client";

// "Who HOLDS this escalation role?" — the inverse of the missing-permission pivot. One row per
// escalation-capable Graph role (AppRoleAssignment.ReadWrite.All and friends), expandable to the
// clients whose m365-admin app registration holds it. These are ADVISORY findings for a security
// review — authority the engine never needs — not gaps to fix. Nothing here removes anything.
import { useState } from "react";
import type { EscalationPivot } from "@/lib/audits/m365-audit";

export function EscalationHoldersTable({ pivot, holders }: { pivot: EscalationPivot[]; holders: number }) {
  const [open, setOpen] = useState<string | null>(null);

  if (!pivot.length) {
    return <p className="note">No client&apos;s app registration holds an escalation-capable role. Nothing over-privileged.</p>;
  }

  return (
    <>
      <p style={{ fontSize: 13 }}>
        <strong>{holders}</strong> client{holders === 1 ? "" : "s"} hold at least one escalation-capable role.
        These let a credential expand its own authority or reach the whole tenant — surfaced for review, never removed automatically.
      </p>
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 4 }}>
        {pivot.map((p) => {
          const isOpen = open === p.role;
          return (
            <div key={p.role} style={{ borderTop: "1px solid #f3f4f6" }}>
              <button
                onClick={() => setOpen(isOpen ? null : p.role)}
                style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "8px 12px", background: "none", border: "none", textAlign: "left", cursor: "pointer" }}
              >
                <span style={{ color: "#b45309", width: 14 }} title="Escalation-capable">⚠</span>
                <code style={{ flex: 1, fontSize: 13 }}>{p.role}</code>
                <span style={{ fontSize: 12 }}>
                  {p.clients.length} holder{p.clients.length === 1 ? "" : "s"}
                </span>
                <span className="muted" style={{ fontSize: 11 }}>{isOpen ? "▴" : "▾"}</span>
              </button>
              {isOpen && (
                <div style={{ padding: "0 12px 12px 36px" }}>
                  <p className="note" style={{ fontSize: 12, margin: "0 0 8px" }}>{p.why}</p>
                  <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
                    {p.clients.map((c) => (
                      <a key={c.slug} href={`/clients/${c.slug}`} title={c.slug}>
                        {c.client || c.slug}
                        {c.client ? <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{c.slug}</span> : null}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
