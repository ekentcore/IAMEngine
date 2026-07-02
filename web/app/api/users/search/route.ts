// Typeahead for the impersonation picker — returns active users matching a name/email query. Gated to
// the REAL super-admin (same as starting an impersonation), so it never leaks the user list otherwise.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireRealSuperAdmin, AuthError } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireRealSuperAdmin();
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  const users = await db.user.findMany({
    where: {
      status: "active",
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
    },
    select: { id: true, name: true, email: true, role: true },
    orderBy: [{ name: "asc" }],
    take: 12,
  });
  return NextResponse.json(users);
}
