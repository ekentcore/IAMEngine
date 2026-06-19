import { test } from "node:test";
import assert from "node:assert/strict";
import { createAndPlanCase } from "./planning-service";
import type { CaseRepository } from "./repository";

// A minimal fake repo (no DB) that records setHold calls — enough to exercise createAndPlanCase's
// hold logic. The client has no systems, so planCase returns [] and no real planning runs.
function fakeRepo(holds: Array<[string, string | null]>): CaseRepository {
  return {
    clientForPlanning: async () => ({
      id: "c1", name: "Acme", slug: "acme", identity: {}, emailDomain: "acme.com",
      primaryDomain: "acme.com", systems: [],
    }),
    createCaseWithJobs: async () => "case1",
    setHold: async (id: string, reason: string | null) => { holds.push([id, reason]); },
    writeAudit: async () => {},
  } as unknown as CaseRepository;
}

test("an imported offboard is auto-held as 'scheduled' (may be future-dated)", async () => {
  const holds: Array<[string, string | null]> = [];
  await createAndPlanCase(fakeRepo(holds), { clientSlug: "acme", action: "offboard", payload: {} }, "tester");
  assert.deepEqual(holds, [["case1", "scheduled"]]);
});

test("a dry-run offboard is NOT auto-held (the operator wants the read-only preview to run now)", async () => {
  const holds: Array<[string, string | null]> = [];
  await createAndPlanCase(fakeRepo(holds), { clientSlug: "acme", action: "offboard", payload: {}, dryRun: true }, "tester");
  assert.equal(holds.length, 0);
});
