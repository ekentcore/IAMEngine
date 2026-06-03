// GET /api/clients/:slug/plan-fields — the v2.1 plan inputs a manual onboard form needs: the
// client's personas (role names + their selectable titles) and location names. Empty for v2.0
// clients (the form then shows only the basic fields).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const c = await db.client.findUnique({ where: { slug: params.slug }, select: { personas: true, locations: true } });
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  const personasObj = (c.personas ?? {}) as Record<string, { titles?: string[] }>;
  const personas = Object.entries(personasObj)
    .map(([name, def]) => ({ name, titles: Array.isArray(def?.titles) ? def.titles : [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const locations = Object.keys((c.locations ?? {}) as Record<string, unknown>);

  return NextResponse.json({ personas, locations, hasPlanConfig: personas.length > 0 });
}
