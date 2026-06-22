"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { ROLE_LABELS, ROLE_DESCRIPTIONS, PERMISSION_LABELS, canResetPassword, canAssignRole } from "@/lib/auth/permissions";
import { createUser, setUserRole, setUserStatus, resetUserPassword } from "../actions";
import { ClientAccessEditor, accessSummary, type ClientLite, type AccessUser } from "./client-access-editor";

type UserVM = {
  id: string; email: string; name: string | null; role: Role; status: string;
  isBreakGlass: boolean; authType: string; lastLoginAt: string | null;
} & AccessUser;

const ALL_ROLES: Role[] = ["super_admin", "global_admin", "ops_manager", "engineer", "importer", "auditor"];

function lastSeen(iso: string | null) {
  if (!iso) return "never";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function UsersView({ users, meRole, clients, meId }: { users: UserVM[]; meRole: Role; clients: ClientLite[]; meId?: string }) {
  const router = useRouter();
  const totalRestricted = clients.filter((c) => c.restricted).length;
  const [accessFor, setAccessFor] = useState<string | null>(null); // user id whose access editor is open
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
            <button style={{ fontSize: 12 }} onClick={() => navigator.clipboard?.writeText(secret.password)}>Copy</button>
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
