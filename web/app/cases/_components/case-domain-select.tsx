"use client";

// Multi-domain clients: pick which email domain THIS case onboards under, before running. Saving
// re-plans the case immediately (identity + jobs rebuild), so the playbook/UPN reflect the choice.
// Options come from the client's curated domain list; the client default is annotated.
import { useState } from "react";
import { useRouter } from "next/navigation";

export function CaseDomainSelect({ caseId, options, defaultDomain, override, started }: {
  caseId: string;
  options: string[]; // client's offered domains (already includes the default)
  defaultDomain: string | null;
  override: string | null; // persisted per-case choice, null = default
  started: boolean; // once jobs have run, replan (and thus this control) is off the table
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (options.length <= 1 && !override) return null; // single-domain client — nothing to choose

  async function apply(domain: string | null) {
    const label = domain ?? `${defaultDomain ?? "the client default"} (default)`;
    if (!confirm(`Re-plan this case with @${label}? The UPN/email and planned steps rebuild.`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/cases/${caseId}/email-domain`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error ?? `failed (${r.status})`); return; }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const current = override ?? "";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <label className="note" style={{ margin: 0 }} htmlFor="case-domain">Email domain</label>
      <select
        id="case-domain"
        className="inline"
        value={current}
        disabled={busy || started}
        title={started
          ? "Steps have already run on this case. Changing the domain now would re-derive the username while the accounts already created keep the old one."
          : "Which of the client's email domains this hire onboards under (re-plans on change)"}
        onChange={(e) => void apply(e.target.value === "" ? null : e.target.value)}
        style={{ fontSize: 12.5 }}
      >
        <option value="">{defaultDomain ?? "client default"} (default)</option>
        {options.filter((d) => d !== defaultDomain).map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      {override && <span style={{ background: "var(--warn-bg)", color: "var(--warn-fg)", borderRadius: 6, padding: "1px 7px", fontSize: 11.5, fontWeight: 600 }}>override</span>}
      {/* A greyed control with only a tooltip reads as "this feature is missing" — which is how this
          landed as a bug report twice (FR #0000089, #0000111) for a picker that works and is in active
          use. Say WHY it is locked and what to do instead, in the open. */}
      {started && (
        <span className="note" style={{ color: "var(--muted)" }}>
          locked — steps have already run. To change it, trash this case and re-open it from the ticket.
        </span>
      )}
      {err && <span className="note" style={{ color: "#b91c1c" }}>{err}</span>}
    </span>
  );
}
