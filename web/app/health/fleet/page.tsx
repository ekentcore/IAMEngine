// Fleet health board — read-only aggregate of every fleet signal (agents/queue/failures/backups/DB).
// Data assembly lives in _lib/loader.ts, shared with v2/v3 and the /api/health/fleet poll route.
// Gated to audit.view (infra-wide, cross-client — deliberately NOT client-scoped).
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { FleetView } from "./_components/fleet-view";
import { loadFleetHealth } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fleet health" };

async function guardFleet() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "audit.view")) redirect("/clients");
  }
}

export default async function FleetHealthPage() {
  await guardFleet();
  const vm = await loadFleetHealth();
  return <FleetView initial={vm} />;
}
