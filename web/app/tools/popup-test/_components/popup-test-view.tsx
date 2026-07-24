"use client";

// Scenario harness for AdminAttentionModal. Every button feeds the REAL component fake (or live)
// data with forceOpen — the key remounts it so the same scenario fires repeatedly. "None" proves
// the modal refuses to open with zero items even when forced.
import { useState } from "react";
import { AdminAttentionModal } from "@/app/_components/admin-attention-modal";
import { attentionStorageKey, type AttentionData } from "@/lib/attention/seen";

const SCENARIOS: { key: string; label: string; data: AttentionData }[] = [
  {
    key: "both",
    label: "Both pending",
    data: { pendingRequests: 3, latestRequestAt: "2026-07-24T12:00:00.000Z", newFeatureRequests: 5, maxFrNumber: 41 },
  },
  {
    key: "requests",
    label: "Only user requests",
    data: { pendingRequests: 2, latestRequestAt: "2026-07-24T12:00:00.000Z", newFeatureRequests: 0, maxFrNumber: 0 },
  },
  {
    key: "frs",
    label: "Only feature requests",
    data: { pendingRequests: 0, latestRequestAt: null, newFeatureRequests: 4, maxFrNumber: 41 },
  },
  {
    key: "none",
    label: "None (must not open)",
    data: { pendingRequests: 0, latestRequestAt: null, newFeatureRequests: 0, maxFrNumber: 0 },
  },
];

export function PopupTestView({ userId, live }: { userId: string | null; live: AttentionData }) {
  const [active, setActive] = useState<{ key: string; run: number; data: AttentionData } | null>(null);
  const [cleared, setCleared] = useState(false);

  function fire(key: string, data: AttentionData) {
    setActive((prev) => ({ key, data, run: (prev?.run ?? 0) + 1 }));
    setCleared(false);
  }

  function clearSeen() {
    try {
      localStorage.removeItem(attentionStorageKey(userId));
      setCleared(true);
    } catch {
      // Storage unavailable — nothing to clear.
    }
  }

  return (
    <main>
      <h1>Popup test</h1>
      <p className="muted">
        Fire the admin attention modal with canned data. Scenario runs never mark anything as seen —
        real popups on other pages are unaffected. To re-test the natural on-load popup, clear the
        seen memory below, then navigate to any page.
      </p>

      <h2>Scenarios</h2>
      <div className="toolbar">
        {SCENARIOS.map((s) => (
          <button key={s.key} type="button" onClick={() => fire(s.key, s.data)}>
            {s.label}
          </button>
        ))}
        <button type="button" onClick={() => fire("live", live)}>
          Live data
        </button>
      </div>
      <p className="note">
        Live right now: {live.pendingRequests} pending user request{live.pendingRequests === 1 ? "" : "s"},{" "}
        {live.newFeatureRequests} new feature request{live.newFeatureRequests === 1 ? "" : "s"}.
      </p>
      {active?.key === "none" && (
        <p className="note">
          &ldquo;None&rdquo; fired — no modal should have appeared (zero items never opens, even forced).
        </p>
      )}

      <h2>Seen memory</h2>
      <p className="muted">
        Dismissing a real popup stores high-water marks in this browser under{" "}
        <code>{attentionStorageKey(userId)}</code>; it re-pops only when something newer arrives.
      </p>
      <div className="toolbar">
        <button type="button" onClick={clearSeen}>
          Clear seen memory
        </button>
        {cleared && <span className="note">Cleared — the next page load pops again if anything is pending.</span>}
      </div>

      {active && (
        <AdminAttentionModal
          key={`${active.key}:${active.run}`}
          userId={userId}
          forceOpen
          onDismiss={() => setActive(null)}
          {...active.data}
        />
      )}
    </main>
  );
}
