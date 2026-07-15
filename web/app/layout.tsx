import "./globals.css";
import Link from "next/link";
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Nav } from "./_components/nav";
import { V2Toggle } from "./_components/v2-toggle";
import { ThemeToggle } from "./_components/theme-toggle";
import { MobileNav } from "./_components/mobile-nav";
import { V2_COOKIE } from "@/lib/v2";
import { UserMenu } from "./_components/user-menu";
import { FeatureRequestButton } from "./_components/feature-request-button";
import { AgentUpdateBanner } from "./_components/agent-update-banner";
import { ImpersonationBanner } from "./_components/impersonation-banner";
import { authEnabled, getActingContext } from "@/lib/auth/current-user";
import { can, ROLE_RANK } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { outdatedAgentCount } from "@/lib/jobs/agent-updates";

// Title template: each page sets its own title (e.g. "Agents") and the tab reads "Agents · iam-engine",
// so people can tell pages apart from the title bar / tab strip.
export const metadata = {
  title: { default: "iam-engine", template: "%s · iam-engine" },
  description: "IAM lifecycle automation",
};

// Mobile: render at device width (without this, phones lay the desktop UI out at ~980px and zoom out).
export const viewport = { width: "device-width", initialScale: 1 };

export const dynamic = "force-dynamic"; // auth state is per-request

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = headers().get("x-pathname") ?? "";
  const onLogin = pathname === "/login";
  const theme = cookies().get("theme")?.value === "dark" ? "dark" : "light";

  // Server-side enforcement: middleware checked the cookie's PRESENCE at the edge; here we validate
  // it (expiry/revocation/active) and bounce an invalid session to /login. /login itself is exempt
  // (it shares this layout) to avoid a redirect loop.
  const acting = authEnabled() ? await getActingContext() : { user: null, realUser: null, impersonating: false };
  const user = acting.user;
  if (authEnabled() && !user && !onLogin) redirect("/login");
  // A real super-admin may impersonate (unless already doing so). Uses the REAL operator, not the
  // effective one, so an impersonated session can't offer to nest another.
  const canImpersonate = authEnabled() && acting.realUser?.role === "super_admin" && !acting.impersonating;

  // Global "agents need updating" banner — on every page EXCEPT /agents (which has its own controls)
  // and /login. Only query when it would actually render (logged in, off those pages).
  const loggedIn = !authEnabled() || !!user;
  const onAgents = pathname === "/agents" || pathname.startsWith("/agents/");
  const canManageAgents = !authEnabled() || (!!user && can(user.role, "agent.manage"));
  const outdatedAgents = loggedIn && !onLogin && !onAgents ? await outdatedAgentCount(db) : 0;

  return (
    <html lang="en" data-theme={theme}>
      <body>
        {!onLogin && (
          <header className="app-header">
            <Link href="/clients" className="brand">iam-engine</Link>
            <Nav
              showUsers={!authEnabled() || (!!user && can(user.role, "user.manage"))}
              showAudit={!authEnabled() || (!!user && can(user.role, "audit.view"))}
              showSettings={!authEnabled() || (!!user && can(user.role, "settings.manage"))}
              showChangelog={!authEnabled() || (!!user && ROLE_RANK[user.role] >= ROLE_RANK.global_admin)}
              showDocs={!authEnabled() || (!!user && ROLE_RANK[user.role] >= ROLE_RANK.engineer)}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
              <MobileNav
                showUsers={!authEnabled() || (!!user && can(user.role, "user.manage"))}
                showAudit={!authEnabled() || (!!user && can(user.role, "audit.view"))}
                showSettings={!authEnabled() || (!!user && can(user.role, "settings.manage"))}
                showChangelog={!authEnabled() || (!!user && ROLE_RANK[user.role] >= ROLE_RANK.global_admin)}
                showDocs={!authEnabled() || (!!user && ROLE_RANK[user.role] >= ROLE_RANK.engineer)}
              />
              {(!authEnabled() || !!user) && <FeatureRequestButton />}
              <ThemeToggle dark={theme === "dark"} />
              <V2Toggle enabled={cookies().get(V2_COOKIE)?.value === "on"} />
              {user && <UserMenu email={user.email} name={user.name} role={user.role} canImpersonate={canImpersonate} />}
            </div>
          </header>
        )}
        {acting.impersonating && user && <ImpersonationBanner name={user.name || user.email} role={user.role} />}
        {outdatedAgents > 0 && <AgentUpdateBanner count={outdatedAgents} canManage={canManageAgents} />}
        {children}
      </body>
    </html>
  );
}
