// POST /api/clients/:slug/parse — detect systems + backbone from pasted instructions.
// Does NOT persist; returns a preview the editor merges in.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { parseInstructionsText } from "@/lib/clients/parse-service";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  let body: { text?: string; useAI?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 422 });
  }
  const result = await parseInstructionsText(body.text, Boolean(body.useAI));
  return NextResponse.json(result);
}
