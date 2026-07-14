// POST /api/admin/llm-providers/:id/test — connectivity test against the STORED key: proves
// endpoint + key + model resolve without exposing the key to the browser. With no body it stays a
// 1-token "ping"; with { question } it asks that instead and returns the model's answer, so an
// operator can confirm the provider really is wired to the model they think it is.
//
// The question travels browser → server only. The route deliberately accepts NO endpoint fields
// (baseUrl/adapter/apiVersion/apiKey): the provider is always loaded from the DB, so this can never
// be used to point the stored key at an attacker-chosen host. The PATCH route's
// re-enter-the-key-to-change-the-endpoint guard depends on that staying true.
// Guarded to settings.manage. Not audited (read-only probe).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { testProvider, TEST_PROMPT_MAX } from "@/lib/fixes/providers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  const provider = await db.llmProvider.findUnique({ where: { id: params.id } });
  if (!provider) return NextResponse.json({ error: "not found" }, { status: 404 });

  // The body is optional — the plain Test button posts nothing at all.
  const body = (await req.json().catch(() => ({}))) as { question?: unknown };
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length > TEST_PROMPT_MAX) {
    return NextResponse.json({ error: `question is too long (max ${TEST_PROMPT_MAX} chars)` }, { status: 422 });
  }

  const result = await testProvider(provider, question);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
