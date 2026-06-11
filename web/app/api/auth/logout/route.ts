// POST /api/auth/logout — revoke the current session + clear the cookie.
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { destroyCurrentSession } from "@/lib/auth/session";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  await destroyCurrentSession();
  if (user) await recordAudit("auth.logout", { user: { ...user } });
  return NextResponse.json({ ok: true });
}
