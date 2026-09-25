import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { makeRunnerService } from "./runner-service";

// FR #81: Google OU discovery — the request/claim/report cycle behind the Google OU pickers.
function stubDb(opts: { agentClientId?: string | null; prev?: unknown; hasGoogle?: boolean } = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    agent: { findUnique: async () => ({ enabled: true, clientId: opts.agentClientId ?? null }) },
    client: {
      findUnique: async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "googleOus" in args.select) return { googleOus: opts.prev ?? null };
        if (args.select && "systems" in args.select) return { id: "c1", systems: opts.hasGoogle === false ? [] : [{ id: "s1" }] };
        return { id: "c1" };
      },
      findMany: async () => [],
      update: async (args: { data: Record<string, unknown> }) => { writes.push(args.data); return { googleOusRequestedById: "u1" }; },
      updateMany: async () => ({ count: 0 }),
    },
    auditLog: { create: async () => ({}) },
  } as unknown as PrismaClient;
  return { db, writes };
}

test("a report stores the cleaned, de-duplicated, sorted OU paths — never the root", async () => {
  const { db, writes } = stubDb();
  const r = await makeRunnerService(db).reportGoogleOus("agent", "acme", ["/Staff/Sales", "/", "  /Active Users ", "/Staff/Sales", "no-slash"]);
  assert.equal(r.count, 2);
  assert.deepEqual((writes[0].googleOus as { ous: string[] }).ous, ["/Active Users", "/Staff/Sales"]);
});

test("a failed read keeps the last good list and records the error", async () => {
  const { db, writes } = stubDb({ prev: { ous: ["/Active Users"], discoveredAt: "2026-09-01T00:00:00.000Z" } });
  await makeRunnerService(db).reportGoogleOus("agent", "acme", [], "403 Not Authorized to access this resource/api");
  assert.deepEqual(writes[0].googleOus, { ous: ["/Active Users"], discoveredAt: "2026-09-01T00:00:00.000Z", error: "403 Not Authorized to access this resource/api" });
});

test("only the central runner can report OUs (a client agent must not write a client's picker)", async () => {
  const { db } = stubDb({ agentClientId: "some-client" });
  await assert.rejects(makeRunnerService(db).reportGoogleOus("agent", "acme", ["/x"]), /only the central runner/);
});

test("a client agent never claims discovery work", async () => {
  const { db } = stubDb({ agentClientId: "some-client" });
  assert.deepEqual(await makeRunnerService(db).claimGoogleOuDiscovery("agent"), []);
});

test("requesting discovery needs a google-workspace system", async () => {
  const { db } = stubDb({ hasGoogle: false });
  await assert.rejects(makeRunnerService(db).requestGoogleOuDiscovery("acme"), /no google-workspace system/);
});
