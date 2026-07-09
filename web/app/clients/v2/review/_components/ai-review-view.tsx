"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ReviewFinding, ReviewSeverity, ReviewCategory } from "@/lib/clients/review";
import { runClientReview } from "../actions";

const SEV_ORDER: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 };
const SEV_COLOR: Record<ReviewSeverity, string> = { high: "#b3261e", medium: "#b45309", low: "#646b7a" };
const CAT_LABEL: Record<ReviewCategory, string> = {
  "missing-domain": "Missing domain",
  "malformed-domain": "Malformed domain",
  "domain-name-mismatch": "Domain ↔ name mismatch",
  "domain-unreachable": "Domain unreachable",
  "email-format": "Email format",
  other: "Other",
};

function dedupeKey(f: ReviewFinding) { return `${f.clientId}:${f.category}:${f.message}`; }

export function AiReviewView({ initial, clientCount, aiAvailable }: { initial: ReviewFinding[]; clientCount: number; aiAvailable: boolean }) {
  const [findings, setFindings] = useState<ReviewFinding[]>(initial);
  const [busy, setBusy] = useState(false);
  const [ranAi, setRanAi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState<string>("all");
  const [checked, setChecked] = useState(0);

  async function runAi() {
    setBusy(true); setError(null);
    try {
      const res = await runClientReview();
      if ("error" in res) { setError(res.error); return; }
      // Replace with the full result (heuristics + live-domain checks + AI), de-duped.
      const seen = new Set<string>();
      setFindings(res.findings.filter((f) => { const k = dedupeKey(f); if (seen.has(k)) return false; seen.add(k); return true; }));
      setChecked(res.domainsChecked);
      setRanAi(true);
    } finally {
      setBusy(false);
    }
  }

  const sorted = useMemo(() => {
    const f = catFilter === "all" ? findings : findings.filter((x) => x.category === catFilter);
    return [...f].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.clientName.localeCompare(b.clientName));
  }, [findings, catFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of findings) c[f.category] = (c[f.category] ?? 0) + 1;
    return c;
  }, [findings]);

  const aiCount = findings.filter((f) => f.source === "ai").length;

  return (
    <>
      <div className="filters" style={{ marginTop: "1rem", alignItems: "center", gap: 8 }}>
        <button className="primary" onClick={runAi} disabled={busy}
          title="Loads every client's domain (homepage title + where it redirects) and sends it with the record to the LLM to flag mismatches — takes ~30–60s">
          {busy ? "Reviewing… (loading domains)" : ranAi ? "↻ Re-run review" : "✨ Run AI review (loads each domain)"}
        </button>
        {!aiAvailable && <span className="note">Azure OpenAI not configured — domain load-checks still run; LLM matching is skipped.</span>}
        {ranAi && <span className="note">Checked {checked} domain{checked === 1 ? "" : "s"} · AI flagged {aiCount}.</span>}
        <select className="inline" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} style={{ marginLeft: "auto" }}>
          <option value="all">All categories ({findings.length})</option>
          {(Object.keys(CAT_LABEL) as ReviewCategory[]).filter((k) => counts[k]).map((k) => (
            <option key={k} value={k}>{CAT_LABEL[k]} ({counts[k]})</option>
          ))}
        </select>
      </div>
      {error && <p className="note danger">{error}</p>}

      {sorted.length === 0 ? (
        <p className="note" style={{ marginTop: "1.5rem" }}>No issues found across {clientCount} clients. 🎉</p>
      ) : (
        <table style={{ marginTop: "0.5rem" }}>
          <thead>
            <tr><th>Severity</th><th>Client</th><th>Issue</th><th>Detail</th><th>Source</th></tr>
          </thead>
          <tbody>
            {sorted.map((f, i) => (
              <tr key={i}>
                <td><span className="badge" style={{ color: SEV_COLOR[f.severity] }}>{f.severity}</span></td>
                <td><Link href={`/clients/${f.slug}`}>{f.clientName}</Link></td>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{CAT_LABEL[f.category]}</td>
                <td>{f.message}</td>
                <td className="muted" style={{ fontSize: 11 }}>{f.source === "ai" ? "✨ AI" : "heuristic"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
