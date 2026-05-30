// Runner-facing endpoints. See docs/RUNNER_PROTOCOL.md.
// POST /api/jobs/claim, /api/jobs/{id}/credential, /api/jobs/{id}/result live under here.
import { NextResponse } from "next/server";
export async function POST() {
  // TODO: atomically claim pending jobs the agent is eligible for -> dispatched
  return NextResponse.json({ todo: "job claim/credential/result per RUNNER_PROTOCOL.md" });
}
