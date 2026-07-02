// POST /api/auth/logout — revoke the current session + clear the cookie.
import { NextResponse } from "next/server";
import { getActingContext } from "@/lib/auth/current-user";
import { destroyCurrentSession } from "@/lib/auth/session";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST() {
  // Audit the logout against the REAL operator even if they were impersonating, so "when did A's
  // session end?" is answerable.
  const ctx = await getActingContext();
  const user = ctx.realUser;
  await destroyCurrentSession();
  if (user) await recordAudit("auth.logout", { user: { ...user } });
  return NextResponse.json({ ok: true });
}
