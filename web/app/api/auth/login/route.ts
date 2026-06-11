// POST /api/auth/login { email, password } — verify a local account, open a session, set the
// cookie. Generic error text on failure (don't reveal which of email/password was wrong). Logs the
// outcome to the audit trail; break-glass logins are flagged at the highest severity.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 422 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return NextResponse.json({ error: "email and password are required" }, { status: 422 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent");

  const user = await db.user.findUnique({ where: { email } });
  const ok = user && user.status === "active" && user.authType !== "sso" && verifyPassword(password, user.passwordHash);
  if (!ok) {
    await recordAudit("auth.login.failed", { actor: "auth", detail: { email, ip } });
    return NextResponse.json({ error: "invalid email or password" }, { status: 401 });
  }

  await createSession(user.id, { ip, userAgent });
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordAudit(user.isBreakGlass ? "auth.login.breakglass" : "auth.login", { user: { ...user }, detail: { ip } });

  return NextResponse.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
}
