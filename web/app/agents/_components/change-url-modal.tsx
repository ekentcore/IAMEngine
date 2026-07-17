"use client";

// The Change-app-URL dialog: set the new app base URL and pick a blast radius — prove the move on
// one runner first (recommended; the canary's success then offers "move all the others"), or send
// the whole fleet at once. Writes the global agent_migration setting via the changeAppUrl action,
// so this is the same state the Settings block edits — just reachable where the runners live.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { changeAppUrl } from "../actions";

export type ChangeUrlAgentOption = { id: string; name: string; online: boolean };

export function ChangeUrlModal({ open, agents, initialUrl, initialAgentId, onClose }: {
  open: boolean;
  agents: ChangeUrlAgentOption[];
  initialUrl: string;
  initialAgentId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [scope, setScope] = useState<"one" | "fleet">("one");
  const [agentId, setAgentId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl(initialUrl);
      setScope("one");
      setAgentId(initialAgentId ?? agents.find((a) => a.online)?.id ?? agents[0]?.id ?? "");
      setError(null);
      ref.current?.showModal();
    } else {
      ref.current?.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await changeAppUrl({ targetUrl: url, scope, agentId: scope === "one" ? agentId : undefined });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    onClose();
    router.refresh();
  }

  return (
    <dialog ref={ref} style={{ maxWidth: 520 }} onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Change app URL</h2>
        <p className="note">
          Move runners to a new app URL. Each runner verifies it can reach the new URL, rewrites its
          own scheduled task, and switches — the old URL is removed once it reports in. Keep the old
          host up until every runner shows migrated.
        </p>
        <label style={{ display: "block", fontSize: 14, margin: "0.75rem 0 0.5rem" }}>
          New app base URL
          <input
            type="url"
            required
            placeholder="https://iam.core.tech"
            value={url}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            style={{ display: "block", marginTop: 4, width: "100%" }}
          />
        </label>
        <div style={{ display: "grid", gap: 6, margin: "0.5rem 0 0.75rem" }}>
          <label style={{ fontSize: 14, display: "flex", gap: 8, alignItems: "baseline" }}>
            <input type="radio" name="move-scope" checked={scope === "one"} disabled={busy} onChange={() => setScope("one")} />
            <span>
              Prove it on one runner first{" "}
              <span className="note muted">— when it lands on the new URL you&rsquo;ll be offered &ldquo;move all the others&rdquo;</span>
            </span>
          </label>
          {scope === "one" && (
            <select value={agentId} disabled={busy} onChange={(e) => setAgentId(e.target.value)} style={{ marginLeft: 24, maxWidth: 320 }}>
              {agents.length === 0 && <option value="">no enabled runners</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.online ? "" : " (offline — moves when it next polls)"}</option>
              ))}
            </select>
          )}
          <label style={{ fontSize: 14, display: "flex", gap: 8, alignItems: "baseline" }}>
            <input type="radio" name="move-scope" checked={scope === "fleet"} disabled={busy} onChange={() => setScope("fleet")} />
            <span>
              Migrate the whole fleet{" "}
              <span className="note muted">— every runner moves on its next heartbeat</span>
            </span>
          </label>
        </div>
        {error && <p className="note danger">{error}</p>}
        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <span className="grow" />
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !url || (scope === "one" && !agentId)}>
            {busy ? "Saving…" : scope === "one" ? "Save URL + move this runner" : "Save URL + move the fleet"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
