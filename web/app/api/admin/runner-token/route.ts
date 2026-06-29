// GET /api/admin/runner-token — returns the RUNNER_API_TOKEN to a signed-in GLOBAL ADMIN (or higher),
// so the runner installer can pull it instead of an operator copy/pasting the secret. Gated hard:
// global_admin/super_admin only, audited every time. NOT under /api/runner (which middleware treats
// as open) — it lives on the session-gated operator surface on purpose.
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { ROLE_RANK } from "@/lib/auth/permissions";
import { authEnabled } from "@/lib/auth/current-user";
import { recordAudit } from "@/lib/auth/audit";
import type { ActingUser } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  let user: ActingUser | undefined;
  if (authEnabled()) {
    const g = await guardAuth(); if (g.res) return g.res;
    if (ROLE_RANK[g.user.role] < ROLE_RANK.global_admin) {
      return NextResponse.json({ error: "forbidden — global admin or higher required to read the runner token" }, { status: 403 });
    }
    user = g.user;
  }
  const token = process.env.RUNNER_API_TOKEN ?? "";
  if (!token) {
    return NextResponse.json({ error: "no RUNNER_API_TOKEN is set on the app (runner auth isn't enforced yet)" }, { status: 409 });
  }
  // Audit the disclosure (the token value is never in the detail).
  await recordAudit("runner.token.read", user ? { user } : { actor: "open-mode" });
  return NextResponse.json({ token });
}
