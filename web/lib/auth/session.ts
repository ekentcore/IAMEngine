// DB-backed sessions: the cookie holds an opaque random token; only its sha256 is stored, so a DB
// leak can't be replayed. Sessions are revocable (logout, admin kill) and expire. Cookie writes
// only work in Route Handlers / Server Actions (not Server Components) — login/logout are routes.
import { randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

export const SESSION_COOKIE = "iam_session";
const TTL_MS = 12 * 60 * 60 * 1000; // 12h

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, meta?: { ip?: string | null; userAgent?: string | null }): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt, ip: meta?.ip ?? null, userAgent: meta?.userAgent ?? null } });
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroyCurrentSession(): Promise<void> {
  const jar = cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.session.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }
  jar.delete(SESSION_COOKIE);
}
