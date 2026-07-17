// POST /api/connectors/import-har — parse a HAR capture into proposed operations (connector.manage).
// This is READ-ONLY: it only analyzes the uploaded capture and returns candidate operations + hosts.
// Nothing is saved; the builder UI turns the admin's selections into a draft via POST /api/connectors.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { importHar } from "@/lib/connectors/import-har";

// A HAR from a busy session can be large; cap what we'll parse so a paste can't OOM the route.
const MAX_HAR_BYTES = 12 * 1024 * 1024;

export async function POST(req: Request) {
  const _g = await guard("connector.manage"); if (_g.res) return _g.res;

  let body: { har?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const har = typeof body.har === "string" ? body.har : "";
  if (!har) return NextResponse.json({ error: "har (the file contents) is required" }, { status: 422 });
  if (har.length > MAX_HAR_BYTES) return NextResponse.json({ error: `HAR is larger than ${MAX_HAR_BYTES} bytes — trim it to just the requests for this task` }, { status: 413 });

  const result = importHar(har);
  return NextResponse.json(result);
}
