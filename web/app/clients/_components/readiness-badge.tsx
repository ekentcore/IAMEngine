"use client";

// Run-readiness badge (ready / partial / not set up), with the via-parent note and the summary
// tooltip. Shared by ClientsTable (v1) and ClientsExplorer (v2).
import type { ClientReadiness } from "@/lib/clients/readiness";
import { READINESS } from "./client-vm";

export function ReadinessBadge({ readiness, viaParent }: { readiness: ClientReadiness; viaParent: string | null }) {
  if (!readiness || readiness.tier === "no_systems") return <span className="muted">—</span>;
  const t = READINESS[readiness.tier];
  return (
    <span className="tip" tabIndex={0} style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
      <span className="badge" style={{ color: t.color, background: t.bg, borderColor: "transparent" }}>
        {t.mark} {t.label}
      </span>
      {viaParent && <span className="note" style={{ fontSize: 10 }}>via {viaParent}</span>}
      <span className="tip-pop">{readiness.summary}{viaParent ? ` — inherited from ${viaParent}` : ""}</span>
    </span>
  );
}
