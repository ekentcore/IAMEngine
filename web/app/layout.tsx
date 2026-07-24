import "./globals.css";
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Nav } from "./_components/nav";
import { VersionToggle } from "./_components/version-toggle";
import { ThemeToggle } from "./_components/theme-toggle";
import { MobileNav } from "./_components/mobile-nav";
import { SITE_VERSION_COOKIE, readSiteVersion } from "@/lib/v2";
import { UserMenu } from "./_components/user-menu";
import { FeatureRequestButton } from "./_components/feature-request-button";
import { FeatureRequestCountSync } from "./_components/feature-request-count-sync";
import { AgentUpdateBanner } from "./_components/agent-update-banner";
import { ImpersonationBanner } from "./_components/impersonation-banner";
import { ServerWatchdog } from "./_components/server-watchdog";
import { AdminAttentionModal } from "./_components/admin-attention-modal";
import { adminAttentionData } from "@/lib/attention/data";
import { isSupervised } from "@/lib/supervised";
import { authEnabled, getActingContext } from "@/lib/auth/current-user";
import { can, ROLE_RANK } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { outdatedAgentCount } from "@/lib/jobs/agent-updates";
import { openFeatureRequestCount } from "./feature-requests/_lib/loader";
import { occasionsFor } from "@/lib/eggs/occasions";
import { effectiveEggDate } from "@/lib/eggs/effective-date";
import { OccasionBanner } from "./_components/eggs/occasion-banner";
import { KonamiEgg } from "./_components/eggs/konami-egg";
import { ConsoleSignature } from "./_components/eggs/console-signature";
import { NewYearEgg } from "./_components/eggs/new-year-egg";
import { DateSimulatorButton, SimulatedDateStrip } from "./_components/eggs/date-simulator";
import { BrandTitle } from "./_components/eggs/brand-title";

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
  // Open-request count for the "Feature requests" menu badge. Cheap COUNT; only when the nav renders.
  const openFeatureRequests = loggedIn && !onLogin ? await openFeatureRequestCount() : 0;

  // Login-time attention popup for global/super admins: pending access requests + untriaged FRs.
  // Keys off the REAL operator — impersonation blocks mutations, so the popup's approve links
  // would 403 — and only queries when it could actually render. Failure-safe: DB trouble reads
  // as "nothing pending" (adminAttentionData never throws).
  const isRealAdmin = !authEnabled() || (!!acting.realUser && ROLE_RANK[acting.realUser.role] >= ROLE_RANK.global_admin);
  const attention = loggedIn && !onLogin && !acting.impersonating && isRealAdmin ? await adminAttentionData() : null;

  // Easter eggs (see docs/superpowers/specs/2026-07-24-easter-eggs-design.md). The simulated_date
  // cookie is honored only for the REAL super-admin (auth off = dev = synthetic super), and only
  // decides which eggs render — nothing else reads it.
  const isRealSuperAdmin = !authEnabled() || acting.realUser?.role === "super_admin";
  const simCookie = cookies().get("simulated_date")?.value;
  const eggDate = effectiveEggDate(simCookie, isRealSuperAdmin);
  const eggs = loggedIn && !onLogin ? occasionsFor(eggDate) : { banners: [], bulbGlyph: "💡", newYear: false };
  const simActive = isRealSuperAdmin && !!simCookie && eggDate === simCookie;

  return (
    <html lang="en" data-theme={theme}>
      <body>
        {/* Every page watches the server's pulse — when the route layer breaks wholesale (the class
            that stalls the runner fleet) this announces the self-restart and reconnects the page. */}
        <ServerWatchdog supervised={isSupervised()} />
        {!onLogin && (
          <header className="app-header">
            <BrandTitle />
            <Nav
              showUsers={!authEnabled() || (!!user && can(user.role, "user.manage"))}
              showAudit={!authEnabled() || (!!user && can(user.role, "audit.view"))}
              showSettings={!authEnabled() || (!!user && can(user.role, "settings.manage"))}
              showChangelog={!authEnabled() || (!!user && ROLE_RANK[user.role] >= ROLE_RANK.global_admin)}
              showDocs={!authEnabled() || (!!user && ROLE_RANK[user.role] >= ROLE_RANK.engineer)}
              showFleetAudit={!authEnabled() || (!!user && can(user.role, "client.edit_secrets"))}
              showConnectors={!authEnabled() || (!!user && can(user.role, "connector.manage"))}
            />
            {/* Renders nothing; keeps the nav badge's open-count store seeded + live (see the component). */}
            <FeatureRequestCountSync serverCount={openFeatureRequests} />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
              <MobileNav
                showUsers={!authEnabled() || (!!user && can(user.role, "user.manage"))}
                showAudit={!authEnabled() || (!!user && can(user.role, "audit.view"))}
                showSettings={!authEnabled() || (!!user && can(user.role, "settings.manage"))}
                showChangelog={!authEnabled() || (!!user && ROLE_RANK[user.role] >= ROLE_RANK.global_admin)}
                showDocs={!authEnabled() || (!!user && ROLE_RANK[user.role] >= ROLE_RANK.engineer)}
                showFleetAudit={!authEnabled() || (!!user && can(user.role, "client.edit_secrets"))}
                showConnectors={!authEnabled() || (!!user && can(user.role, "connector.manage"))}
              />
              {isRealSuperAdmin && !onLogin && <DateSimulatorButton current={simActive ? simCookie : undefined} />}
              {(!authEnabled() || !!user) && <FeatureRequestButton glyph={eggs.bulbGlyph} />}
              <ThemeToggle dark={theme === "dark"} />
              <VersionToggle version={readSiteVersion(cookies().get(SITE_VERSION_COOKIE)?.value)} />
              {user && <UserMenu email={user.email} name={user.name} role={user.role} canImpersonate={canImpersonate} />}
            </div>
          </header>
        )}
        {acting.impersonating && user && <ImpersonationBanner name={user.name || user.email} role={user.role} />}
        {outdatedAgents > 0 && <AgentUpdateBanner count={outdatedAgents} canManage={canManageAgents} />}
        {simActive && !onLogin && <SimulatedDateStrip date={eggDate} />}
        {eggs.banners.map((b, i) => <OccasionBanner key={i} banner={b} />)}
        {loggedIn && !onLogin && (
          <>
            <KonamiEgg />
            <ConsoleSignature />
            {eggs.newYear && <NewYearEgg year={eggDate.slice(0, 4)} />}
            {attention && <AdminAttentionModal userId={user?.id ?? null} {...attention} />}
          </>
        )}
        {children}
      </body>
    </html>
  );
}
