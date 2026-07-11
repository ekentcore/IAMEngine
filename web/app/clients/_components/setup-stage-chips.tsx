"use client";

// The per-system setup checklist as five compact chips (Started ▸ Wired ▸ Fields ▸ Test ▸ Rights),
// plus the two operator actions that aren't derivable from live state: "Mark started" and
// "Attest rights…" (which records a manual rights verification AND overrides the dispatch gate
// for a failing test). Everything else on the row is derived — chips update on refresh.
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SystemSetupVector, SetupStepState } from "@/lib/clients/readiness";

const STEP_LABELS: { key: keyof Omit<SystemSetupVector, "complete">; label: string; help: string }[] = [
  { key: "started", label: "started", help: "An operator opened the setup instructions (or a later step implies it)" },
  { key: "wired", label: "wired", help: "Every required secret has a usable Delinea reference" },
  { key: "preflight", label: "fields", help: "App-side check: the secret resolves and carries the fields its connector needs" },
  { key: "test", label: "test", help: "Live connection test: resolve + connect + one read" },
  { key: "rights", label: "rights", help: "Per-operation rights probe, or an operator attestation" },
];

function chipStyle(state: SetupStepState): { color: string; text: string } {
  switch (state) {
    case "done": return { color: "#15803d", text: "✓" };
    case "attested": return { color: "#15803d", text: "✓*" };
    case "failed": return { color: "#b91c1c", text: "✗" };
    case "pending": return { color: "#92400e", text: "○" };
    case "not_needed": return { color: "var(--muted)", text: "—" };
    default: return { color: "var(--muted)", text: "?" };
  }
}

export function SetupStageChips({ slug, systemKey, vector, attested }: { slug: string; systemKey: string; vector: SystemSetupVector; attested: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(action: "start" | "attest" | "clear_attest") {
    let note = "";
    if (action === "attest") {
      const v = window.prompt(`Attest that you verified the ${systemKey} credential's rights manually (optional note):`);
      if (v === null) return; // cancelled
      note = v;
    }
    setBusy(true);
    try {
      await fetch(`/api/clients/${slug}/systems/${systemKey}/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {STEP_LABELS.map(({ key, label, help }) => {
        const state = vector[key];
        const c = chipStyle(state);
        return (
          <span key={key} className="badge" style={{ color: c.color, fontSize: 12 }} title={`${help} — ${state}`}>
            {c.text} {label}
          </span>
        );
      })}
      {vector.started === "pending" && (
        <button onClick={() => act("start")} disabled={busy} style={{ fontSize: 11 }} title="Record that setup for this system has begun">
          Mark started
        </button>
      )}
      {(vector.rights === "unknown" || vector.rights === "failed") && !attested && (
        <button onClick={() => act("attest")} disabled={busy} style={{ fontSize: 11 }} title="Record that you verified this credential's rights manually (also clears the dispatch gate for a failing test)">
          Attest rights…
        </button>
      )}
      {attested && (
        <button onClick={() => act("clear_attest")} disabled={busy} style={{ fontSize: 11 }} title="Withdraw the manual rights attestation">
          Clear attestation
        </button>
      )}
    </span>
  );
}
