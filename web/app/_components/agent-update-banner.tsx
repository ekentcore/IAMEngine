"use client";

// Global banner: shows on every page (except /agents and /login) when one or more enrolled runners
// are not on the build the app serves. "Update all" queues a self-update for every outdated agent
// and then jumps to the Agents page so the operator can watch them flip to up-to-date.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateAllOutdatedAgents } from "../agents/actions";

export function AgentUpdateBanner({ count, canManage }: { count: number; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function updateAll() {
    setBusy(true);
    setError(null);
    const res = await updateAllOutdatedAgents();
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }
    // Switch to the Agents page to watch them update; refresh so its live list reflects the queue.
    router.push("/agents");
    router.refresh();
  }

  const n = count;
  return (
    <div
      role="status"
      style={{
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        padding: "0.5rem 1rem", background: "#fffbeb", borderBottom: "1px solid #fde68a", color: "#92400e", fontSize: 13,
      }}
    >
      <span>
        <b>⚠ {n} agent{n === 1 ? "" : "s"} need{n === 1 ? "s" : ""} updating</b> — running an older build than the app serves.
      </span>
      <span style={{ flex: 1 }} />
      {error && <span style={{ color: "#b91c1c" }}>{error}</span>}
      {canManage ? (
        <button
          onClick={updateAll}
          disabled={busy}
          style={{ fontSize: 12, padding: "0.25rem 0.7rem", border: "1px solid #d97706", borderRadius: 6, background: "#f59e0b", color: "#1c1917", fontWeight: 600, cursor: busy ? "default" : "pointer" }}
        >
          {busy ? "Queuing…" : `Update all (${n})`}
        </button>
      ) : (
        <a href="/agents" style={{ fontSize: 12, color: "#92400e", fontWeight: 600 }}>View agents →</a>
      )}
    </div>
  );
}
