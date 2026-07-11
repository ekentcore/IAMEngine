// Shared data assembly for /health/connections and /health/connections/v2: guard (audit.view),
// fetch every client/system connection-test result, and map to plain view-model rows.
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { makeRunnerService } from "@/lib/jobs/runner-service";

export type ConnectionRow = {
  client: string; slug: string; systemKey: string;
  status: string; detail: string | null; accessOk: boolean | null;
  onPrem: boolean; finishedAt: string | null; claimedAt: string | null;
};

export async function loadConnectionsPage(): Promise<ConnectionRow[]> {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "audit.view")) redirect("/clients");
  }
  const tests = await makeRunnerService(db).listAllConnectionTests();
  return tests.map((t) => ({
    client: t.client.name,
    slug: t.client.slug,
    systemKey: t.systemKey,
    status: t.status,
    detail: t.detail ?? t.accessDetail ?? null,
    accessOk: t.accessOk,
    onPrem: t.onPrem,
    finishedAt: t.finishedAt ? t.finishedAt.toISOString() : null,
    claimedAt: t.claimedAt ? t.claimedAt.toISOString() : null,
  }));
}
