// Account v2: same identity table + change-password as /account — only the header presentation
// differs (v2 header with a signed-in summary + back-link). Reachable from the header menu.
import Link from "next/link";
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { ChangePassword } from "../_components/change-password";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account (v2)" };

export default async function AccountV2Page() {
  if (!authEnabled()) {
    return (
      <main style={{ maxWidth: 520 }}>
        <div className="row-between">
          <h1>Account <span className="note">(v2)</span></h1>
          <Link href="/account" className="note" style={{ alignSelf: "flex-start" }}>← back to Account</Link>
        </div>
        <p className="note">Sign-in is currently disabled (AUTH_ENABLED is off), so there&rsquo;s no account to manage.</p>
      </main>
    );
  }
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  return (
    <main style={{ maxWidth: 520 }}>
      <div className="row-between">
        <div>
          <h1>Account <span className="note">(v2)</span></h1>
          <p className="note">Signed in as {me.email} · {ROLE_LABELS[me.role]}</p>
        </div>
        <Link href="/account" className="note" style={{ alignSelf: "flex-start" }}>← back to Account</Link>
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
