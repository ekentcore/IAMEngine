// PATCH/DELETE /api/admin/llm-providers/:id — edit or remove a fix-lane LLM provider. A blank or
// omitted apiKey on PATCH keeps the stored key (the UI never sees it, so it can't send it back).
// Guarded to settings.manage; audited without the key.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { providerInputProblem, setDefaultFlag, toMasked } from "@/lib/fixes/providers";
import type { LlmAdapter } from "@/lib/fixes/provider-presets";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  const existing = await db.llmProvider.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: { name?: unknown; adapter?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown; isDefault?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const merged = {
    name: body.name ?? existing.name,
    adapter: body.adapter ?? existing.adapter,
    baseUrl: body.baseUrl ?? existing.baseUrl,
    model: body.model ?? existing.model,
  };
  const problem = providerInputProblem(merged);
  if (problem) return NextResponse.json({ error: problem }, { status: 422 });
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : null;
  if (apiKey && apiKey.length > 500) return NextResponse.json({ error: "apiKey too long" }, { status: 422 });

  const updated = await db.llmProvider.update({
    where: { id: existing.id },
    data: {
      name: (merged.name as string).trim(),
      adapter: merged.adapter as LlmAdapter,
      baseUrl: (merged.baseUrl as string).trim(),
      model: (merged.model as string).trim(),
      ...(apiKey ? { apiKey } : {}),
    },
  });
  if (typeof body.isDefault === "boolean" && body.isDefault !== existing.isDefault) {
    await setDefaultFlag(db, existing.id, body.isDefault);
    updated.isDefault = body.isDefault;
  }

  await recordAudit("settings.llmprovider.update", { user: g.user, detail: { id: updated.id, name: updated.name, adapter: updated.adapter, model: updated.model, keyRotated: !!apiKey } });
  return NextResponse.json({ provider: toMasked(updated) });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  const existing = await db.llmProvider.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.llmProvider.delete({ where: { id: existing.id } });
  // If the default was deleted, promote the oldest remaining provider so the lane keeps working.
  if (existing.isDefault) {
    const next = await db.llmProvider.findFirst({ orderBy: { createdAt: "asc" } });
    if (next) await db.llmProvider.update({ where: { id: next.id }, data: { isDefault: true } });
  }

  await recordAudit("settings.llmprovider.delete", { user: g.user, detail: { id: existing.id, name: existing.name } });
  return NextResponse.json({ ok: true });
}
