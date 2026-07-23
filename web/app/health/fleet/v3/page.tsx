// Fleet health v3 (Version 3 slider): identical data + view via the shared loader/component.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { FleetView } from "../_components/fleet-view";
import { loadFleetHealth } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fleet health" };

export default async function FleetHealthV3Page() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "audit.view")) redirect("/clients");
  }
  const vm = await loadFleetHealth();
  return <FleetView initial={vm} />;
}
