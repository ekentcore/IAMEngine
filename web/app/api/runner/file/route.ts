// GET /api/runner/file?path=<relative> — raw content of one runner file (path-guarded).
import { NextResponse } from "next/server";
import { readRunnerFile } from "@/lib/runner/bundle";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  const content = readRunnerFile(path);
  if (content === null) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(content, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
