// Shared page-data loader for /users and /users/v2 — the auth gate, queries, and view-models
// live here once so the two variants can't drift. requirePermission still guards every action
// server-side; the gate here just hides the page from non-admins.
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";

export async function loadUsersPage() {
  // The acting role drives which password resets / role changes the UI offers (server still enforces).
  let meRole: Role = "super_admin";
  let meId: string | undefined;
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "user.manage")) redirect("/clients");
    meRole = me.role;
    meId = me.id;
  }
  const [users, clients, accessRequests] = await Promise.all([
    db.user.findMany({
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, email: true, name: true, role: true, status: true, isBreakGlass: true, authType: true, lastLoginAt: true,
        clientAccessMode: true,
        clientAccess: { select: { clientId: true, kind: true } },
      },
    }),
    // The client roster for the access editor (which ones are restricted, so the UI can label them).
    db.client.findMany({ where: { status: "active" }, orderBy: { name: "asc" }, select: { id: true, name: true, restricted: true } }),
    // Pending access requests — verified SSO sign-ins from people not yet provisioned, held for approval.
    db.accessRequest.findMany({ where: { status: "pending" }, orderBy: { lastRequestedAt: "desc" }, select: { id: true, email: true, name: true, requestCount: true, firstRequestedAt: true, lastRequestedAt: true } }),
  ]);
  const vms = users.map((u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, status: u.status,
    isBreakGlass: u.isBreakGlass, authType: u.authType, lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    accessMode: u.clientAccessMode,
    scopeClientIds: u.clientAccess.filter((a) => a.kind === "scope").map((a) => a.clientId),
    grantClientIds: u.clientAccess.filter((a) => a.kind === "grant").map((a) => a.clientId),
  }));
  const requestVms = accessRequests.map((r) => ({
    id: r.id, email: r.email, name: r.name, requestCount: r.requestCount,
    firstRequestedAtIso: r.firstRequestedAt.toISOString(), lastRequestedAtIso: r.lastRequestedAt.toISOString(),
  }));
  return { meRole, meId, users: vms, clients, accessRequests: requestVms };
}
