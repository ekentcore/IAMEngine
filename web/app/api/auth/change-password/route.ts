// POST /api/auth/change-password { currentPassword, newPassword } — the signed-in user changes
// their own local password. Verifies the current one, enforces a minimum length, and revokes OTHER
// sessions so a stolen old session can't survive a password change.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getActingContext } from "@/lib/auth/current-user";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { hashToken, SESSION_COOKIE } from "@/lib/auth/session";
import { recordAudit } from "@/lib/auth/audit";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Changing your password is always about the REAL operator, and it's a mutation — refuse while
  // impersonating (the effective user is someone else).
  const ctx = await getActingContext();
  const me = ctx.realUser;
  if (!me) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  if (ctx.impersonating) return NextResponse.json({ error: "exit impersonation before changing your password" }, { status: 403 });

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 422 });
  }
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (next.length < 10) return NextResponse.json({ error: "new password must be at least 10 characters" }, { status: 422 });
  if (me.authType === "sso") return NextResponse.json({ error: "this account signs in with SSO — there's no local password to change" }, { status: 422 });
  if (!verifyPassword(current, me.passwordHash)) return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });

  const keepToken = cookies().get(SESSION_COOKIE)?.value;
  await db.user.update({ where: { id: me.id }, data: { passwordHash: hashPassword(next) } });
  // Revoke every OTHER live session (keep the current one so the user stays signed in here).
  await db.session.updateMany({
    where: { userId: me.id, revokedAt: null, ...(keepToken ? { tokenHash: { not: hashToken(keepToken) } } : {}) },
    data: { revokedAt: new Date() },
  });
  await recordAudit("auth.change_password", { user: { ...me } });
  return NextResponse.json({ ok: true });
}
