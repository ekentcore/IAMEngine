"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { AgentScope } from "@prisma/client";
import { enrollAgent, setAgentEnabled } from "../actions";

export type AgentVM = {
  id: string;
  name: string;
  scope: AgentScope;
  clientSlug: string | null;
  clientName: string | null;
  version: string | null;
  enabled: boolean;
  lastSeenAt: string | null;
  jobCount: number;
};

function lastSeen(iso: string | null): { text: string; online: boolean } {
  if (!iso) return { text: "never", online: false };
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const online = secs < 90;
  if (secs < 60) return { text: `${secs}s ago`, online };
  if (secs < 3600) return { text: `${Math.round(secs / 60)}m ago`, online };
  if (secs < 86400) return { text: `${Math.round(secs / 3600)}h ago`, online };
  return { text: new Date(iso).toLocaleDateString(), online };
}

export function AgentsView({ agents, clients }: { agents: AgentVM[]; clients: { slug: string; name: string }[] }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<AgentScope>("central");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; scope: string } | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  function open() {
    setError(null);
    setCreated(null);
    setScope("central");
    ref.current?.showModal();
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const clientSlug = String(form.get("clientSlug") ?? "").trim() || null;
    const res = await enrollAgent({ name, scope, clientSlug: scope === "client_network" ? clientSlug : null });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCreated({ id: res.id, scope: res.scope });
    router.refresh();
  }

  async function toggle(id: string, enabled: boolean) {
    setToggling(id);
    await setAgentEnabled(id, enabled);
    setToggling(null);
    router.refresh();
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "<APP_URL>";

  return (
    <>
      <div className="toolbar" style={{ marginBottom: "1rem" }}>
        <span className="grow" />
        <button className="primary" onClick={open}>Enroll agent</button>
      </div>

      <table>
        <thead>
          <tr><th>Name</th><th>Scope</th><th>Client</th><th>Version</th><th>Last seen</th><th>Jobs</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const ls = lastSeen(a.lastSeenAt);
            return (
              <tr key={a.id}>
                <td><div>{a.name}</div><code className="muted" style={{ fontSize: 11 }}>{a.id}</code></td>
                <td><span className="badge">{a.scope === "central" ? "central" : "client-network"}</span></td>
                <td>{a.clientName ?? <span className="muted">— all —</span>}</td>
                <td>{a.version ?? <span className="muted">—</span>}</td>
                <td><span style={{ color: ls.online ? "#2e7d32" : undefined }}>{ls.online ? "● " : ""}{ls.text}</span></td>
                <td>{a.jobCount}</td>
                <td>{a.enabled ? "enabled" : <span className="muted">disabled</span>}</td>
                <td><button onClick={() => toggle(a.id, !a.enabled)} disabled={toggling === a.id}>{a.enabled ? "Disable" : "Enable"}</button></td>
              </tr>
            );
          })}
          {agents.length === 0 && (
            <tr><td colSpan={8} className="muted" style={{ textAlign: "center" }}>No agents yet. Enroll one to start a runner.</td></tr>
          )}
        </tbody>
      </table>

      <dialog ref={ref}>
        {!created ? (
          <form onSubmit={submit}>
            <h2>Enroll agent</h2>
            <p className="note">A central agent executes cloud (api) jobs for all clients. A client-network agent runs inside one client&apos;s network and only sees that client&apos;s jobs.</p>

            <label htmlFor="name">Name</label>
            <input id="name" name="name" placeholder="central-cloud-runner" required />

            <label htmlFor="scope">Scope</label>
            <select id="scope" name="scope" value={scope} onChange={(e) => setScope(e.target.value as AgentScope)}>
              <option value="central">central (all clients, cloud)</option>
              <option value="client_network">client-network (one client)</option>
            </select>

            {scope === "client_network" && (
              <>
                <label htmlFor="clientSlug">Client</label>
                <input id="clientSlug" name="clientSlug" list="agent-client-options" placeholder="client slug" required />
                <datalist id="agent-client-options">
                  {clients.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </datalist>
              </>
            )}

            {error && <p className="note" style={{ color: "#9a3a3a" }}>{error}</p>}

            <div className="toolbar" style={{ marginTop: "1rem", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
              <button type="submit" className="primary" disabled={busy}>{busy ? "Enrolling…" : "Enroll"}</button>
            </div>
          </form>
        ) : (
          <div>
            <h2>Agent enrolled</h2>
            <p className="note">Copy the id and start the runner with it.</p>

            <label>Agent id</label>
            <div className="toolbar">
              <input readOnly value={created.id} style={{ fontFamily: "monospace" }} onFocus={(e) => e.currentTarget.select()} />
              <button onClick={() => navigator.clipboard?.writeText(created.id)}>Copy</button>
            </div>

            <label style={{ marginTop: "0.75rem" }}>Start the runner</label>
            <textarea readOnly rows={3} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
              value={`# set RUNNER_API_TOKEN first if the app has one configured\npwsh runner/Start-IamRunner.ps1 \\\n  -AppUrl ${origin} -AgentId ${created.id}`} />

            <div className="toolbar" style={{ marginTop: "1rem", justifyContent: "flex-end" }}>
              <button className="primary" onClick={() => ref.current?.close()}>Done</button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
