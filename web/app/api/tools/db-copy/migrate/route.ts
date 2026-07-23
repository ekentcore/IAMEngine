// POST /api/tools/db-copy/migrate — "Build schema": run `prisma migrate deploy` against the
// destination described in the form, so its schema is created natively by Prisma before a data copy.
// Runs on the app server; the password is transient (child env only) and scrubbed from output. Guard
// settings.manage. Audited (db_migrate.deploy) on both success and failure — who + where + outcome.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { connFromProfile, normalizeProfileInput } from "@/lib/db-copy/dest-profile";
import { runPrismaMigrateDeploy } from "@/lib/db-copy/migrate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const norm = normalizeProfileInput(body);
  if (!norm.ok) return NextResponse.json({ ok: false as const, error: `destination missing: ${norm.missing.join(", ")}` }, { status: 400 });
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) return NextResponse.json({ ok: false as const, error: "destination password is required" }, { status: 400 });
  const dest = connFromProfile(norm.profile, password);

  const result = await runPrismaMigrateDeploy(dest);
  await recordAudit("db_migrate.deploy", {
    user: g.user,
    detail: {
      dest: `${dest.host}:${dest.port}/${dest.database}`, // never the password
      ok: result.ok,
    },
  });
  return NextResponse.json({ ok: result.ok, output: result.output });
}
