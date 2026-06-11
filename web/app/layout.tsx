import "./globals.css";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Nav } from "./_components/nav";
import { UserMenu } from "./_components/user-menu";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";

// Title template: each page sets its own title (e.g. "Agents") and the tab reads "Agents · iam-engine",
// so people can tell pages apart from the title bar / tab strip.
export const metadata = {
  title: { default: "iam-engine", template: "%s · iam-engine" },
  description: "IAM lifecycle automation",
};

export const dynamic = "force-dynamic"; // auth state is per-request

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = headers().get("x-pathname") ?? "";
  const onLogin = pathname === "/login";

  // Server-side enforcement: middleware checked the cookie's PRESENCE at the edge; here we validate
  // it (expiry/revocation/active) and bounce an invalid session to /login. /login itself is exempt
  // (it shares this layout) to avoid a redirect loop.
  const user = authEnabled() ? await getCurrentUser() : null;
  if (authEnabled() && !user && !onLogin) redirect("/login");

  return (
    <html lang="en">
      <body>
        {!onLogin && (
          <header className="app-header">
            <Link href="/clients" className="brand">iam-engine</Link>
            <Nav
              showUsers={!authEnabled() || (!!user && can(user.role, "user.manage"))}
              showAudit={!authEnabled() || (!!user && can(user.role, "audit.view"))}
            />
            {user && <UserMenu email={user.email} name={user.name} role={user.role} />}
          </header>
        )}
        {children}
      </body>
    </html>
  );
}
