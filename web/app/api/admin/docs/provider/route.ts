// GET — the name of the default LLM provider, shown in the "Update with AI" progress modal. Fetched
// lazily when the modal opens (rare) rather than on every manager document view, so reading a doc
// doesn't carry an extra provider query. Manage-docs gated like the update itself.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDefaultProvider } from "@/lib/fixes/providers";
import { guardManageDocs } from "@/lib/docs/route-gate";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guardManageDocs();
  if (g.res) return g.res;
  const provider = await getDefaultProvider(db);
  return NextResponse.json({ name: provider?.name ?? null });
}
