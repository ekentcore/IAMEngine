// Resolve the signed-in operator from the session cookie. Runs in the Node runtime (Server
// Components / Route Handlers / Server Actions) where Prisma is available — NOT in edge middleware,
// which only checks cookie presence. authEnabled() is the rollout flag: while false the app behaves
// exactly as before (no login required) so the cutover is deliberate and can't lock anyone out.
import { cookies } from "next/headers";
import type { User } from "@prisma/client";
import { db } from "@/lib/db";
import { SESSION_COOKIE, hashToken } from "./session";

export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === "true";
}

export async function getCurrentUser(): Promise<User | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.user.status !== "active") return null;
  return session.user;
}
