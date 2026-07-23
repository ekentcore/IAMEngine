// Account v3 (the "Version 3" slider serves this at /account): same identity table + change-password
// as v2 via the shared auth helpers. v3 chrome — clean header (no v1 back-link, no "(v2)" label);
// keeps the authEnabled()===false branch and the redirect("/login") guard.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { ChangePassword } from "../_components/change-password";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account" };

export default async function AccountV3Page() {
  if (!authEnabled()) {
    return (
      <main style={{ maxWidth: 520 }}>
        <h1>Account</h1>
        <p className="note">Sign-in is currently disabled (AUTH_ENABLED is off), so there&rsquo;s no account to manage.</p>
      </main>
    );
  }
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  return (
    <main style={{ maxWidth: 520 }}>
      <div>
        <h1>Account</h1>
        <p className="note">Signed in as {me.email} · {ROLE_LABELS[me.role]}</p>
      </div>
      <table style={{ marginTop: "0.75rem" }}>
        <tbody>
          <tr><th style={{ width: 140 }}>Name</th><td>{me.name || "—"}</td></tr>
          <tr><th>Email</th><td>{me.email}</td></tr>
          <tr><th>Role</th><td>{ROLE_LABELS[me.role]}</td></tr>
          <tr><th>Sign-in</th><td>{me.authType === "sso" ? "Microsoft 365 (SSO)" : "Local password"}</td></tr>
        </tbody>
      </table>
      {me.authType !== "sso" && <ChangePassword />}
    </main>
  );
}
