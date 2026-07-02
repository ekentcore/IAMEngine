// Super-admin "view as" impersonation. POST { userId } starts it (sets impersonatingUserId on the
// current session); DELETE stops it. The gate is the REAL operator (ignoring any active impersonation)
// so an impersonated session can't start a nested one. Every start/stop is audited. Mutations are
// blocked while impersonating (see requirePermission) — this is view-only.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { requireRealSuperAdmin, AuthError } from "@/lib/auth/guard";
import { getRealUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE, hashToken } from "@/lib/auth/session";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

async function currentSession() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return db.session.findUnique({ where: { tokenHash: hashToken(token) } });
}

export async function POST(req: Request) {
  let real;
  try {
    real = await requireRealSuperAdmin();
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });

  let body: { userId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const userId = String(body.userId ?? "");
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, role: true, status: true } });
  if (!target || target.status !== "active") return NextResponse.json({ error: "user not found or inactive" }, { status: 404 });
  if (target.id === real.id) return NextResponse.json({ error: "you can't impersonate yourself" }, { status: 422 });

  await db.session.update({ where: { id: session.id }, data: { impersonatingUserId: target.id } });
  await recordAudit("user.impersonate.start", { user: real, detail: { targetId: target.id, targetEmail: target.email, targetRole: target.role } });
  return NextResponse.json({ ok: true, impersonating: { name: target.name, email: target.email, role: target.role } });
}

export async function DELETE() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "no session" }, { status: 401 });
  if (session.impersonatingUserId) {
    const real = await getRealUser(); // the actual operator, for the audit actor
    await db.session.update({ where: { id: session.id }, data: { impersonatingUserId: null } });
    await recordAudit("user.impersonate.stop", { user: real ?? undefined, detail: { wasImpersonating: session.impersonatingUserId } });
  }
  return NextResponse.json({ ok: true });
}
