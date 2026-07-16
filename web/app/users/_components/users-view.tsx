"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { ROLE_LABELS, ROLE_DESCRIPTIONS, PERMISSION_LABELS, canResetPassword, canAssignRole } from "@/lib/auth/permissions";
import { createUser, setUserRole, setUserStatus, resetUserPassword, approveAccessRequest, denyAccessRequest } from "../actions";
import { ClientAccessEditor, accessSummary, type ClientLite, type AccessUser } from "./client-access-editor";
import { CopyButton } from "@/app/_components/copy-button";

type UserVM = {
  id: string; email: string; name: string | null; role: Role; status: string;
  isBreakGlass: boolean; authType: string; lastLoginAt: string | null;
} & AccessUser;

export type AccessRequestVM = { id: string; email: string; name: string | null; requestCount: number; firstRequestedAtIso: string; lastRequestedAtIso: string };

const ALL_ROLES: Role[] = ["super_admin", "global_admin", "ops_manager", "engineer", "importer", "auditor"];

function lastSeen(iso: string | null) {
  if (!iso) return "never";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function UsersView({ users, meRole, clients, meId, accessRequests = [], v2 = false }: { users: UserVM[]; meRole: Role; clients: ClientLite[]; meId?: string; accessRequests?: AccessRequestVM[]; v2?: boolean }) {
  const router = useRouter();
  const totalRestricted = clients.filter((c) => c.restricted).length;
  const [accessFor, setAccessFor] = useState<string | null>(null); // user id whose access editor is open
  const [approving, setApproving] = useState<AccessRequestVM | null>(null); // access request being approved
  // super_admin only appears in the pickers for a super admin (others can't grant it). The guide +
  // create form use this; per-row selects also keep a target's own (super) role visible.
  const ROLES: Role[] = meRole === "super_admin" ? ALL_ROLES : ALL_ROLES.filter((r) => r !== "super_admin");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  // add form
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("engineer");
  const [authType, setAuthType] = useState<"sso" | "local">("sso");
  const [newPassword, setNewPassword] = useState(""); // only used for a super creating a local user
  const canMakeLocal = meRole === "super_admin"; // local (password) users are super-admin only

  async function run<T extends { ok: boolean; error?: string; generatedPassword?: string }>(key: string, fn: () => Promise<T>, who?: string) {
    setBusy(key); setError(null);
    try {
      const r = await fn();
      if (!r.ok) { setError(r.error ?? "failed"); return; }
      if (r.generatedPassword && who) setSecret({ email: who, password: r.generatedPassword });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {/* role guide */}
      <details style={{ marginTop: "1rem", border: "1px solid var(--line)", borderRadius: 10, padding: "0.6rem 0.9rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 14 }}>What can each role do?</summary>
        <div style={{ marginTop: "0.6rem", display: "grid", gap: "0.55rem" }}>
          {ROLES.map((r) => (
            <div key={r} style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "0.6rem", alignItems: "baseline" }}>
              <div style={{ fontWeight: 600 }}>{ROLE_LABELS[r]}</div>
              <div className="note" style={{ fontSize: 12.5 }}>{ROLE_DESCRIPTIONS[r]}</div>
            </div>
          ))}
          <p className="note" style={{ margin: "0.3rem 0 0", color: "var(--faint)" }}>
            To let someone run onboardings & offboardings, use <b>Engineer</b>. If they should also approve the
            destructive offboard steps themselves (no separate approver), use <b>Operations manager</b>.
          </p>
        </div>
      </details>

      {/* Requested access: verified SSO sign-ins from unprovisioned people, held for approval. */}
      {accessRequests.length > 0 && (
        <div style={{ border: "1px solid var(--warn-fg)", borderRadius: 10, padding: "0.8rem 1rem", marginTop: "1rem", background: "var(--warn-bg)" }}>
          <b style={{ fontSize: 14 }}>Requested access ({accessRequests.length})</b>
          <p className="note" style={{ margin: "2px 0 8px" }}>People who signed in with Microsoft 365 but aren&apos;t provisioned yet. Approve to create their account (deny-by-default until then).</p>
          <table>
            <thead><tr><th>Email</th><th>Name</th><th className="num">Requests</th><th>Last requested</th><th></th></tr></thead>
            <tbody>
              {accessRequests.map((r) => (
                <tr key={r.id}>
                  <td>{r.email}</td>
                  <td className="muted">{r.name ?? "—"}</td>
                  <td className="num">{r.requestCount}</td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{lastSeen(r.lastRequestedAtIso)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="primary" onClick={() => setApproving(r)}>Approve…</button>
                    <button style={{ marginLeft: 6 }} disabled={busy === `deny-${r.id}`} onClick={() => run(`deny-${r.id}`, () => denyAccessRequest(r.id))}>{busy === `deny-${r.id}` ? "…" : "Deny"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {approving && <ApproveDialog req={approving} clients={clients} roles={ROLES} onClose={() => setApproving(null)} onDone={() => { setApproving(null); router.refresh(); }} />}

      {/* add user */}
      <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "0.9rem 1rem", marginTop: "1rem", background: "var(--bg-soft)" }}>
        <b style={{ fontSize: 14 }}>Add user</b>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "flex-end", marginTop: "0.5rem" }}>
          <div style={{ flex: "1 1 200px" }}><label htmlFor="nu-email">Email</label><input id="nu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@core.tech" /></div>
          <div style={{ flex: "1 1 160px" }}><label htmlFor="nu-name">Name</label><input id="nu-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" /></div>
          <div style={{ flex: "0 1 180px" }}><label htmlFor="nu-role">Role</label>
            <select id="nu-role" value={role} onChange={(e) => setRole(e.target.value as Role)} title={ROLE_DESCRIPTIONS[role]}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
          <div style={{ flex: "0 1 170px" }}><label htmlFor="nu-auth">Sign-in</label>
            <select id="nu-auth" value={authType} onChange={(e) => setAuthType(e.target.value as "sso" | "local")}
              title={canMakeLocal ? "" : "Only a super admin can create local (password) users"}>
              <option value="sso">Microsoft 365 (SSO)</option>
              {canMakeLocal && <option value="local">Local password</option>}
            </select>
          </div>
          {canMakeLocal && authType === "local" && (
            <div style={{ flex: "1 1 200px" }}><label htmlFor="nu-pw">Password</label>
              <input id="nu-pw" type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="set one, or leave blank to generate" autoComplete="new-password" />
            </div>
          )}
          <button className="primary" disabled={busy === "create" || !email.trim()}
            onClick={() => run("create", () => createUser({ email, name, role, authType, password: authType === "local" ? (newPassword.trim() || undefined) : undefined }), email.trim().toLowerCase()).then(() => { setEmail(""); setName(""); setNewPassword(""); })}>
            {busy === "create" ? "Adding…" : "Add user"}
          </button>
        </div>
        <p className="note" style={{ margin: "0.5rem 0 0" }}>
          {authType === "sso"
            ? "They sign in with Microsoft 365 — no password is set; they just click “Sign in with Microsoft 365” (their email must match)."
            : newPassword.trim()
              ? "A local user with the password you set (you already have it — no email is sent)."
              : "A local user with a one-time password generated and shown after you add them (no email is sent)."}{" "}
          {!canMakeLocal && <span className="note">Local (password) users are super-admin only.</span>}{" "}
          <b>{ROLE_LABELS[role]}</b>: {ROLE_DESCRIPTIONS[role]}
        </p>
      </div>

      {secret && (
        <div style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 10, padding: "0.7rem 0.9rem", marginTop: "0.75rem" }}>
          <b>Password for {secret.email}</b> — shown once, copy it now:
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            <code style={{ fontSize: 13 }}>{secret.password}</code>
            {/* Shown once; "Dismiss" is the only other button. A copy that silently no-ops loses it. */}
            <CopyButton text={secret.password} label="Copy" copiedLabel="Copied ✓" style={{ fontSize: 12 }} />
            <button style={{ fontSize: 12 }} onClick={() => setSecret(null)}>Dismiss</button>
          </div>
        </div>
      )}
      {error && <p className="note danger" style={{ marginTop: "0.5rem" }}>{error}</p>}

      <table style={{ marginTop: "1rem" }}>
        <thead><tr><th>User</th><th>Role</th><th>Client access</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <Fragment key={u.id}>
            <tr>
              <td>
                <div style={{ fontWeight: 600 }}>{u.name || u.email}</div>
                <div className="note" style={{ fontSize: 11 }}>{u.email}{u.isBreakGlass && " · break-glass"}{u.authType === "sso" && " · SSO"}</div>
              </td>
              <td>
                {/* A super's role can only be changed by another super; the super_admin option only
                    shows for a super (or on a super's own row, so the current value renders). */}
                {(() => {
                  const lockRole = u.role === "super_admin" && meRole !== "super_admin";
                  const rowRoles = meRole === "super_admin" || u.role === "super_admin" ? ALL_ROLES : ROLES;
                  return (
                    <select value={u.role} title={lockRole ? "Only a super admin can change a super admin's role" : ROLE_DESCRIPTIONS[u.role]}
                      disabled={busy === `role-${u.id}` || lockRole}
                      onChange={(e) => run(`role-${u.id}`, () => setUserRole(u.id, e.target.value))} style={{ width: "auto", fontSize: 12 }}>
                      {rowRoles.map((r) => <option key={r} value={r} disabled={!canAssignRole(meRole, u.role, r)}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  );
                })()}
              </td>
              <td>
                {/* Super admins always see every client (they bypass scoping) — no editor. */}
                {u.role === "super_admin" ? (
                  <span className="note" title="Super admins bypass client scoping — they always see every client.">All clients</span>
                ) : (
                  <button style={{ fontSize: 12 }} title="Scope which clients this user can see"
                    onClick={() => setAccessFor(accessFor === u.id ? null : u.id)}>
                    {accessSummary(u, totalRestricted)} ✎
                  </button>
                )}
              </td>
              <td><span className="badge" style={{ color: u.status === "active" ? "#15803d" : "#b91c1c", background: u.status === "active" ? "#e8f5ee" : "#fcebe9" }}>{u.status}</span></td>
              <td className="note">{lastSeen(u.lastLoginAt)}</td>
              <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                {(() => {
                  const allowed = canResetPassword(meRole, u.role);
                  const why = u.authType === "sso" ? "SSO user — no local password"
                    : !allowed ? (u.role === "super_admin" ? "Only a super admin can reset a super admin's password" : "You can't reset a more senior user's password")
                    : "Generate a new one-time password";
                  return (
                    <button style={{ fontSize: 12 }} disabled={busy === `pw-${u.id}` || u.authType === "sso" || !allowed} title={why}
                      onClick={() => run(`pw-${u.id}`, () => resetUserPassword(u.id), u.email)}>
                      Reset password
                    </button>
                  );
                })()}
                <button style={{ fontSize: 12, marginLeft: 6 }} disabled={busy === `st-${u.id}`}
                  onClick={() => run(`st-${u.id}`, () => setUserStatus(u.id, u.status === "active" ? "disabled" : "active"))}>
                  {u.status === "active" ? "Disable" : "Enable"}
                </button>
                {v2 && (
                  <a href={`/audit/v2?user=${u.id}`} className="linklike" style={{ fontSize: 12, marginLeft: 8 }} title="See the audit log for just this user">
                    Logs
                  </a>
                )}
              </td>
            </tr>
            {accessFor === u.id && u.role !== "super_admin" && (
              <tr>
                <td colSpan={6} style={{ background: "var(--bg-soft)" }}>
                  <ClientAccessEditor
                    user={u}
                    clients={clients}
                    isSelf={u.id === meId}
                    onSaved={() => { setAccessFor(null); router.refresh(); }}
                    onCancel={() => setAccessFor(null)}
                  />
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Approve an access request → create the user with a chosen role + client scope. Defaults are least-
// privilege: role auditor, mode "only" with NO clients selected (so approval never grants broad access
// by accident) — both changeable here before approving.
function ApproveDialog({ req, clients, roles, onClose, onDone }: {
  req: AccessRequestVM; clients: ClientLite[]; roles: Role[]; onClose: () => void; onDone: () => void;
}) {
  const [role, setRole] = useState<Role>("auditor");
  const [mode, setMode] = useState<"all" | "only" | "exclude">("only");
  const [scope, setScope] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filtered = clients.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) => setScope((s) => { const x = new Set(s); x.has(id) ? x.delete(id) : x.add(id); return x; });
  async function submit() {
    setBusy(true); setError(null);
    const r = await approveAccessRequest(req.id, { role, mode, scopeClientIds: [...scope] });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "failed"); return; }
    onDone();
  }
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 1rem", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 12, padding: "1rem 1.2rem", width: 540, maxWidth: "100%", boxShadow: "var(--shadow-1)" }}>
        <div className="row-between"><h2 style={{ margin: 0 }}>Approve access</h2><button onClick={onClose} aria-label="Close">×</button></div>
        <p className="note">Create an account for <b>{req.email}</b>{req.name ? ` (${req.name})` : ""}. They sign in with Microsoft 365 (SSO).</p>

        <label htmlFor="ar-role">Role</label>
        <select id="ar-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
        </select>

        <label htmlFor="ar-mode" style={{ marginTop: 10, display: "block" }}>Client access</label>
        <select id="ar-mode" value={mode} onChange={(e) => setMode(e.target.value as "all" | "only" | "exclude")}>
          <option value="only">Only selected clients (default — none until you pick)</option>
          <option value="all">All clients (except restricted)</option>
          <option value="exclude">All clients except selected</option>
        </select>
        {mode !== "all" && (
          <div style={{ marginTop: 8 }}>
            <input placeholder="search clients…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} spellCheck={false} />
            <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, marginTop: 6, padding: 6 }}>
              {filtered.map((c) => (
                <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 4px", whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={scope.has(c.id)} onChange={() => toggle(c.id)} style={{ width: "auto" }} />
                  {c.name}{c.restricted && <span className="note" style={{ color: "var(--warn-fg)" }}>· restricted</span>}
                </label>
              ))}
              {filtered.length === 0 && <div className="note" style={{ padding: 4 }}>no clients match</div>}
            </div>
            <p className="note" style={{ marginTop: 4 }}>{scope.size} selected — default is <b>none</b> so approval doesn&apos;t grant access too broadly. You can change this later on the user row.</p>
          </div>
        )}
        {error && <p className="note danger">{error}</p>}
        <div className="dialog-actions" style={{ marginTop: 12 }}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>{busy ? "Approving…" : "Approve & create user"}</button>
        </div>
      </div>
    </div>
  );
}
