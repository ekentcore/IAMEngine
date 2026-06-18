"use server";
// User administration (Global Admin only — user.manage). Create operators, set their role, enable/
// disable, and reset passwords. Generated passwords are returned to the caller ONCE for display.
import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission, AuthError } from "@/lib/auth/guard";
import { hashPassword, generatePassword } from "@/lib/auth/password";
import { recordAudit } from "@/lib/auth/audit";
import { canResetPassword, canAssignRole } from "@/lib/auth/permissions";

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

const ROLES: Role[] = ["super_admin", "global_admin", "ops_manager", "engineer", "importer", "auditor"];
const isRole = (r: unknown): r is Role => typeof r === "string" && ROLES.includes(r as Role);

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof AuthError ? e.message : e instanceof Error ? e.message : "failed" };
}

export async function createUser(input: { email: string; name?: string; role: string; authType?: string; password?: string }): Promise<Result<{ generatedPassword?: string }>> {
  try {
    const me = await requirePermission("user.manage");
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "enter a valid email" };
    if (!isRole(input.role)) return { ok: false, error: "invalid role" };
    // Only a super admin may create another super admin.
    if (input.role === "super_admin" && me.role !== "super_admin") return { ok: false, error: "only a super admin can grant the super admin role" };
    // Creating a LOCAL (password) user — or setting a password at creation — is super-admin only.
    // Everyone else can only create Microsoft 365 (SSO) users.
    const wantsLocal = input.authType === "local" || !!input.password?.trim();
    if (wantsLocal && me.role !== "super_admin") return { ok: false, error: "only a super admin can create a local (password) user" };
    if (input.password?.trim() && input.password.trim().length < 8) return { ok: false, error: "the password must be at least 8 characters" };
    if (await db.user.findUnique({ where: { email } })) return { ok: false, error: "a user with that email already exists" };
    // SSO users sign in with Microsoft 365 (no local password). Local users get one (set by the super
    // admin, or generated if not supplied), shown once to the admin.
    const sso = !wantsLocal;
    const password = sso ? null : input.password?.trim() || generatePassword();
    await db.user.create({
      data: { email, name: input.name?.trim() || null, role: input.role, authType: sso ? "sso" : "local", passwordHash: password ? hashPassword(password) : null },
    });
    await recordAudit("user.create", { user: me, detail: { email, role: input.role, authType: sso ? "sso" : "local" } });
    revalidatePath("/users");
    return { ok: true, generatedPassword: !sso && !input.password ? (password ?? undefined) : undefined };
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
    // Granting/changing the super admin tier is super-only — a global can't promote to super or
    // re-role a super (which would let them dodge the password-reset rule).
    if (!canAssignRole(me.role, target.role, role)) {
      return { ok: false, error: "only a super admin can grant or change the super admin role" };
    }
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
    const target = await db.user.findUnique({ where: { id: userId }, select: { email: true, role: true } });
    if (!target) return { ok: false, error: "user not found" };
    // Seniority rule: a super resets anyone; a global resets global-or-lower; only a super resets a super.
    if (!canResetPassword(me.role, target.role)) {
      return { ok: false, error: target.role === "super_admin" ? "only a super admin can reset a super admin's password" : "you can't reset the password of a user more senior than you" };
    }
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
