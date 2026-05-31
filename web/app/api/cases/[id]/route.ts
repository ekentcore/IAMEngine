// GET /api/cases/:id — case detail with planned jobs.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const c = await makeCaseRepository(db).getCase(params.id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(c);
}
