// GET/POST /api/admin/llm-providers — the fix lane's LLM provider registry (Settings page).
// GET lists providers with the API key MASKED (last 4 only — the key never leaves the server);
// POST creates one. Guarded to settings.manage (global_admin+); audited without the key.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { listProvidersMasked, providerInputProblem, setDefaultFlag, toMasked } from "@/lib/fixes/providers";
import type { LlmAdapter } from "@/lib/fixes/provider-presets";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  return NextResponse.json({ providers: await listProvidersMasked(db) });
}

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  let body: { name?: unknown; adapter?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown; isDefault?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const problem = providerInputProblem(body);
  if (problem) return NextResponse.json({ error: problem }, { status: 422 });
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey || apiKey.length > 500) return NextResponse.json({ error: "apiKey is required" }, { status: 422 });

  const count = await db.llmProvider.count();
  const created = await db.llmProvider.create({
    data: {
      name: (body.name as string).trim(),
      adapter: body.adapter as LlmAdapter,
      baseUrl: (body.baseUrl as string).trim(),
      model: (body.model as string).trim(),
      apiKey,
      // The very first provider is the default regardless — the fix lane needs one.
      isDefault: count === 0 || body.isDefault === true,
    },
  });
  if (created.isDefault) await setDefaultFlag(db, created.id, true);

  await recordAudit("settings.llmprovider.create", { user: g.user, detail: { id: created.id, name: created.name, adapter: created.adapter, model: created.model } });
  return NextResponse.json({ provider: toMasked(created) }, { status: 201 });
}
