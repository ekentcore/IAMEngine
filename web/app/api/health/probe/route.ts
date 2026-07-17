// GET /api/health/probe — the liveness probe behind the self-heal watchdog and the in-page
// "server is restarting" modal. Deliberately PUBLIC (middleware passes it through): its whole
// purpose is to prove that route code executes, which /api/health cannot do — that path answers 401
// from the middleware before any route compiles, so it reads "healthy" while every real route 500s
// (exactly what hid the 2026-07-17 module-graph outage).
//
// The body carries a marker ("probe":"iam") so callers can tell OUR answer from anything else that
// might respond on the port, plus one bit of database reachability. It reveals nothing else.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error("db probe timeout")), 2500)),
    ]);
    dbOk = true;
  } catch {
    dbOk = false; // reported, not thrown — "route ran, DB didn't" is the signal (see self-heal.ts)
  }
  return NextResponse.json({ probe: "iam", db: dbOk });
}
