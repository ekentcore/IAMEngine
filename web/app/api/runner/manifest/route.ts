// GET /api/runner/manifest — the list of runner files the installer downloads (no zip needed).
import { NextResponse } from "next/server";
import { listRunnerFiles } from "@/lib/runner/bundle";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ files: listRunnerFiles() });
}
