// The signed-in operator's own account: identity + change-password. Reachable from the header menu.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { ChangePassword } from "./_components/change-password";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account" };

export default async function AccountPage() {
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
      <h1>Account</h1>
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
