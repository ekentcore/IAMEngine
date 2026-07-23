// GET /api/health/fleet — the fleet-health board's poll endpoint. Calls the SAME loadFleetHealth()
// the SSR page uses, so the polled view can't drift from the first render. Read-only; force-dynamic so
// the aggregate is always fresh. Gated to audit.view (infra-wide, cross-client read).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { loadFleetHealth } from "@/app/health/fleet/_lib/loader";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET() {
  const g = await guard("audit.view");
  if (g.res) return g.res;
  const vm = await loadFleetHealth();
  return NextResponse.json(vm);
}
