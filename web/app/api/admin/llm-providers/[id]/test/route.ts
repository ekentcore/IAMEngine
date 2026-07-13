// POST /api/admin/llm-providers/:id/test — 1-token connectivity test against the stored key:
// proves endpoint + key + model resolve without exposing the key to the browser. Guarded to
// settings.manage. Not audited (read-only probe).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { testProvider } from "@/lib/fixes/providers";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  const provider = await db.llmProvider.findUnique({ where: { id: params.id } });
  if (!provider) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = await testProvider(provider);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
