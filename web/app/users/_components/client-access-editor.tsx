"use client";

import { useState } from "react";
import type { ClientAccessMode } from "@prisma/client";
import { setUserClientAccess } from "../actions";

export type ClientLite = { id: string; name: string; restricted: boolean };
export type AccessUser = {
  id: string;
  email: string;
  name: string | null;
  accessMode: ClientAccessMode;
  scopeClientIds: string[];
  grantClientIds: string[];
};

const MODE_LABEL: Record<ClientAccessMode, string> = {
  all: "All clients",
  only: "Only selected clients",
  exclude: "All clients except selected",
};

// Inline editor for which clients a user may see. Restricted (internal-only) clients are hidden from
// everyone until granted, so they get their own grant list in all/exclude mode (in only-mode, listing
// one in the allowlist grants it).
export function ClientAccessEditor({
  user,
  clients,
  isSelf,
  onSaved,
  onCancel,
}: {
  user: AccessUser;
  clients: ClientLite[];
  isSelf: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<ClientAccessMode>(user.accessMode);
  const [scope, setScope] = useState<Set<string>>(new Set(user.scopeClientIds));
  const [grant, setGrant] = useState<Set<string>>(new Set(user.grantClientIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restricted = clients.filter((c) => c.restricted);

  function toggle(set: Set<string>, setSet: (s: Set<string>) => void, id: string) {
    const n = new Set(set);
    n.has(id) ? n.delete(id) : n.add(id);
    setSet(n);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const r = await setUserClientAccess(user.id, {
      mode,
      scopeClientIds: mode === "all" ? [] : [...scope],
      grantClientIds: mode === "only" ? [] : [...grant],
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else onSaved();
  }

  const box: React.CSSProperties = { maxHeight: 190, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: "0.4rem 0.6rem", margin: "0.3rem 0", display: "grid", gap: 2 };
  const row = (c: ClientLite, checked: boolean, onChange: () => void) => (
    <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400, fontSize: 13, cursor: "pointer" }}>
      <input type="checkbox" style={{ width: "auto" }} checked={checked} onChange={onChange} />
      <span>{c.name}{c.restricted && <span title="restricted (internal-only)" style={{ marginLeft: 6, color: "#a23f3f" }}>🔒</span>}</span>
    </label>
  );

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "0.7rem 0.9rem", background: "var(--bg-soft)" }}>
      <b style={{ fontSize: 13 }}>Client access for {user.name || user.email}</b>
      {isSelf && <p className="note" style={{ margin: "0.25rem 0 0", color: "#92400e" }}>This is your own account — scoping yourself down can hide clients from you.</p>}

      <div style={{ display: "flex", gap: 14, margin: "0.5rem 0 0.2rem", flexWrap: "wrap" }}>
        {(["all", "only", "exclude"] as ClientAccessMode[]).map((m) => (
          <label key={m} style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400, fontSize: 13, cursor: "pointer" }}>
            <input type="radio" name={`mode-${user.id}`} style={{ width: "auto" }} checked={mode === m} onChange={() => setMode(m)} />
            {MODE_LABEL[m]}
          </label>
        ))}
      </div>

      {mode === "only" && (
        <div>
          <p className="note" style={{ margin: "0.3rem 0 0" }}>Sees ONLY the clients you check (a restricted client checked here is thereby granted):</p>
          <div style={box}>{clients.map((c) => row(c, scope.has(c.id), () => toggle(scope, setScope, c.id)))}</div>
        </div>
      )}

      {mode === "exclude" && (
        <div>
          <p className="note" style={{ margin: "0.3rem 0 0" }}>Sees all clients EXCEPT the ones you check:</p>
          <div style={box}>{clients.map((c) => row(c, scope.has(c.id), () => toggle(scope, setScope, c.id)))}</div>
        </div>
      )}

      {mode !== "only" && restricted.length > 0 && (
        <div>
          <p className="note" style={{ margin: "0.4rem 0 0" }}>Restricted (internal-only) clients this user may see — none are visible unless granted here:</p>
          <div style={box}>{restricted.map((c) => row(c, grant.has(c.id), () => toggle(grant, setGrant, c.id)))}</div>
        </div>
      )}
      {mode !== "only" && restricted.length === 0 && (
        <p className="note" style={{ margin: "0.4rem 0 0", color: "var(--faint)" }}>No restricted clients yet — mark a client “restricted” on the Clients page to gate it.</p>
      )}

      {error && <p className="note danger" style={{ marginTop: "0.4rem" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: "0.55rem" }}>
        <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save access"}</button>
        <button disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// One-line summary of a user's access for the table cell.
export function accessSummary(u: AccessUser, totalRestricted: number): string {
  if (u.accessMode === "all") {
    const g = u.grantClientIds.length;
    return g > 0 ? `All clients · +${g} restricted` : totalRestricted > 0 ? "All (non-restricted)" : "All clients";
  }
  if (u.accessMode === "only") return `Only ${u.scopeClientIds.length} client${u.scopeClientIds.length === 1 ? "" : "s"}`;
  const g = u.grantClientIds.length;
  return `All except ${u.scopeClientIds.length}${g > 0 ? ` · +${g} restricted` : ""}`;
}
