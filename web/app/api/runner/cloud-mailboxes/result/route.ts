// POST /api/runner/cloud-mailboxes/result — { agentId, clientSlug, mailboxes:[{address,displayName}] }.
// The central runner posts the tenant's shared mailboxes (enumerated over Exchange Online during the
// same discovery as cloud groups); stored on the client to back the default shared-mailbox picker.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request) {
  let body: { agentId?: unknown; clientSlug?: unknown; mailboxes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  if (typeof body.clientSlug !== "string" || !body.clientSlug) return NextResponse.json({ error: "clientSlug is required" }, { status: 422 });
  const mailboxes = Array.isArray(body.mailboxes)
    ? body.mailboxes
        .filter((m): m is { address: string; displayName?: unknown } => !!m && typeof m === "object" && typeof (m as { address?: unknown }).address === "string")
        .map((m) => ({ address: String(m.address), displayName: typeof m.displayName === "string" ? m.displayName : "" }))
    : [];
  try {
    const out = await makeRunnerService(db).reportCloudMailboxes(body.agentId, body.clientSlug, mailboxes);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
