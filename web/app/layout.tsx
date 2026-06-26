import "./globals.css";
import Link from "next/link";
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Nav } from "./_components/nav";
import { V2Toggle } from "./_components/v2-toggle";
import { V2_COOKIE } from "@/lib/v2";
import { UserMenu } from "./_components/user-menu";
import { AgentUpdateBanner } from "./_components/agent-update-banner";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { outdatedAgentCount } from "@/lib/jobs/agent-updates";

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

  // Global "agents need updating" banner — on every page EXCEPT /agents (which has its own controls)
  // and /login. Only query when it would actually render (logged in, off those pages).
  const loggedIn = !authEnabled() || !!user;
  const onAgents = pathname === "/agents" || pathname.startsWith("/agents/");
  const canManageAgents = !authEnabled() || (!!user && can(user.role, "agent.manage"));
  const outdatedAgents = loggedIn && !onLogin && !onAgents ? await outdatedAgentCount(db) : 0;

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
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
              <V2Toggle enabled={cookies().get(V2_COOKIE)?.value === "on"} />
              {user && <UserMenu email={user.email} name={user.name} role={user.role} />}
            </div>
          </header>
        )}
        {outdatedAgents > 0 && <AgentUpdateBanner count={outdatedAgents} canManage={canManageAgents} />}
        {children}
      </body>
    </html>
  );
}
