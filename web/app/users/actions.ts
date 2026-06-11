"use server";
// User administration (Global Admin only — user.manage). Create operators, set their role, enable/
// disable, and reset passwords. Generated passwords are returned to the caller ONCE for display.
import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission, AuthError } from "@/lib/auth/guard";
import { hashPassword, generatePassword } from "@/lib/auth/password";
import { recordAudit } from "@/lib/auth/audit";

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

const ROLES: Role[] = ["global_admin", "ops_manager", "engineer", "importer", "auditor"];
const isRole = (r: unknown): r is Role => typeof r === "string" && ROLES.includes(r as Role);

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof AuthError ? e.message : e instanceof Error ? e.message : "failed" };
}

export async function createUser(input: { email: string; name?: string; role: string; password?: string }): Promise<Result<{ generatedPassword?: string }>> {
  try {
    const me = await requirePermission("user.manage");
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "enter a valid email" };
    if (!isRole(input.role)) return { ok: false, error: "invalid role" };
    if (await db.user.findUnique({ where: { email } })) return { ok: false, error: "a user with that email already exists" };
    const password = input.password?.trim() || generatePassword();
    await db.user.create({
      data: { email, name: input.name?.trim() || null, role: input.role, authType: "local", passwordHash: hashPassword(password) },
    });
    await recordAudit("user.create", { user: me, detail: { email, role: input.role } });
    revalidatePath("/users");
    return { ok: true, generatedPassword: input.password ? undefined : password };
  } catch (e) {
    return fail(e);
  }
}

export async function setUserRole(userId: string, role: string): Promise<Result> {
  try {
    const me = await requirePermission("user.manage");
    if (!isRole(role)) return { ok: false, error: "invalid role" };
    const target = await db.user.findUnique({ where: { id: userId }, select: { email: true, role: true } });
    if (!target) return { ok: false, error: "user not found" };
    await db.user.update({ where: { id: userId }, data: { role } });
    await recordAudit("user.set_role", { user: me, detail: { email: target.email, from: target.role, to: role } });
    revalidatePath("/users");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setUserStatus(userId: string, status: "active" | "disabled"): Promise<Result> {
  try {
    const me = await requirePermission("user.manage");
    const target = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!target) return { ok: false, error: "user not found" };
    // Disabling kills the user's live sessions immediately.
    await db.$transaction([
      db.user.update({ where: { id: userId }, data: { status } }),
      ...(status === "disabled" ? [db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })] : []),
    ]);
    await recordAudit(status === "disabled" ? "user.disable" : "user.enable", { user: me, detail: { email: target.email } });
    revalidatePath("/users");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function resetUserPassword(userId: string, password?: string): Promise<Result<{ generatedPassword?: string }>> {
  try {
    const me = await requirePermission("user.manage");
    const target = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!target) return { ok: false, error: "user not found" };
    const pw = password?.trim() || generatePassword();
    // A password reset also revokes existing sessions (forces re-login).
    await db.$transaction([
      db.user.update({ where: { id: userId }, data: { passwordHash: hashPassword(pw), authType: "local" } }),
      db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await recordAudit("user.reset_password", { user: me, detail: { email: target.email } });
    revalidatePath("/users");
    return { ok: true, generatedPassword: password ? undefined : pw };
  } catch (e) {
    return fail(e);
  }
}
