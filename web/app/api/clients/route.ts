// Phase 1 stubs. GET = list clients; POST = add a client (onboard); PATCH = archive.
import { NextResponse } from "next/server";
export async function GET() {
  // TODO: prisma.client.findMany({ include: { systems: true } })
  return NextResponse.json({ todo: "list clients with their systems + manual flags" });
}
export async function POST() {
  // TODO: create Client + default ClientSystem rows ("onboard a client")
  return NextResponse.json({ todo: "add client" }, { status: 201 });
}
export async function PATCH() {
  // TODO: set status = archived ("offboard a client")
  return NextResponse.json({ todo: "archive client" });
}
