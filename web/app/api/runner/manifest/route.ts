// GET /api/runner/manifest — the list of runner files the installer downloads (no zip needed).
import { NextResponse } from "next/server";
import { runnerBundle } from "@/lib/runner/bundle";

export const dynamic = "force-dynamic";

export function GET() {
  // One walk produces BOTH the file list and the build id, so they can't disagree mid-deploy.
  return NextResponse.json(runnerBundle());
}
