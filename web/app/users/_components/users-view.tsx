"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { ROLE_LABELS, ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { createUser, setUserRole, setUserStatus, resetUserPassword } from "../actions";

type UserVM = {
  id: string; email: string; name: string | null; role: Role; status: string;
  isBreakGlass: boolean; authType: string; lastLoginAt: string | null;
};

const ROLES: Role[] = ["global_admin", "ops_manager", "engineer", "importer", "auditor"];

function lastSeen(iso: string | null) {
  if (!iso) return "never";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function UsersView({ users }: { users: UserVM[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  // add form
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("engineer");

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
      {/* add user */}
      <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "0.9rem 1rem", marginTop: "1rem", background: "var(--bg-soft)" }}>
        <b style={{ fontSize: 14 }}>Add user</b>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "flex-end", marginTop: "0.5rem" }}>
          <div style={{ flex: "1 1 200px" }}><label htmlFor="nu-email">Email</label><input id="nu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@core.tech" /></div>
          <div style={{ flex: "1 1 160px" }}><label htmlFor="nu-name">Name</label><input id="nu-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" /></div>
          <div style={{ flex: "0 1 200px" }}><label htmlFor="nu-role">Role</label>
            <select id="nu-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
          <button className="primary" disabled={busy === "create" || !email.trim()}
            onClick={() => run("create", () => createUser({ email, name, role }), email.trim().toLowerCase()).then(() => { setEmail(""); setName(""); })}>
            {busy === "create" ? "Adding…" : "Add user"}
          </button>
        </div>
        <p className="note" style={{ margin: "0.5rem 0 0" }}>
          A one-time password is generated and shown after you add the user (no email is sent). {ROLE_LABELS[role]} can:{" "}
          {ROLE_PERMISSIONS[role].join(", ")}.
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
        <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                <div style={{ fontWeight: 600 }}>{u.name || u.email}</div>
                <div className="note" style={{ fontSize: 11 }}>{u.email}{u.isBreakGlass && " · break-glass"}{u.authType === "sso" && " · SSO"}</div>
              </td>
              <td>
                <select value={u.role} disabled={busy === `role-${u.id}`} onChange={(e) => run(`role-${u.id}`, () => setUserRole(u.id, e.target.value))} style={{ width: "auto", fontSize: 12 }}>
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              </td>
              <td><span className="badge" style={{ color: u.status === "active" ? "#15803d" : "#b91c1c", background: u.status === "active" ? "#e8f5ee" : "#fcebe9" }}>{u.status}</span></td>
              <td className="note">{lastSeen(u.lastLoginAt)}</td>
              <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                <button style={{ fontSize: 12 }} disabled={busy === `pw-${u.id}` || u.authType === "sso"} title={u.authType === "sso" ? "SSO user — no local password" : "Generate a new one-time password"}
                  onClick={() => run(`pw-${u.id}`, () => resetUserPassword(u.id), u.email)}>
                  Reset password
                </button>
                <button style={{ fontSize: 12, marginLeft: 6 }} disabled={busy === `st-${u.id}`}
                  onClick={() => run(`st-${u.id}`, () => setUserStatus(u.id, u.status === "active" ? "disabled" : "active"))}>
                  {u.status === "active" ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
