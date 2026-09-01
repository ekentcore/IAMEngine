import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { importCaseFromServiceNow } from "./import-service";
import { createAndPlanCase, EngineOptOutError } from "./planning-service";
import type { CaseRepository } from "./repository";

// A client marked "do not use engine" must be left completely alone by the engine: no new cases
// imported, no already-imported case touched, and no case creatable from the New case form.

// Fake db for the import path. The SN number is already imported and the case is TRASHED — the
// exact state that used to be resurrected every sweep. `engineOptOut` = the case's client is
// opted out. `calls.restore` counts the un-trash write (repo.restoreCase).
function fakeDb(opts: { existingCaseId?: string; engineOptOut: boolean }) {
  const calls = { restore: 0 };
  const db = {
    // FR #0000096: the planner reads unmodeled runbook sections to plan manual checklist steps.
    runbookSection: { findMany: async () => [] },
    caseRequest: {
      findUnique: async (a: { where: { serviceNowCaseNumber?: string; id?: string } }) => {
        // repo.findCaseIdByNumber
        if (a.where.serviceNowCaseNumber) return opts.existingCaseId ? { id: opts.existingCaseId } : null;
        // Serves BOTH caseClientOptedOut (client.engineOptOut) and repo.restoreCase (deletedAt).
        return {
          id: opts.existingCaseId,
          clientId: "c1",
          deletedAt: new Date("2026-07-01"), // trashed
          client: { engineOptOut: opts.engineOptOut },
        };
      },
      update: async () => { calls.restore++; }, // repo.restoreCase's un-trash write
    },
    client: {
      findUnique: async () => ({ engineOptOut: opts.engineOptOut }),
    },
  };
  return { db: db as unknown as PrismaClient, calls };
}

test("an opted-out client's already-imported case is NOT restored by a re-import", async () => {
  const { db, calls } = fakeDb({ existingCaseId: "case1", engineOptOut: true });
  const r = await importCaseFromServiceNow(db, "UM0001234", "system:intake-poll");
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, "engine_opt_out");
  // The whole point: a trashed case must STAY trashed, or every 15-min sweep re-opens it.
  assert.equal(calls.restore, 0, "restoreCase must not run for an opted-out client");
});

test("a normal client's already-imported case IS still restored (unchanged behavior)", async () => {
  const { db, calls } = fakeDb({ existingCaseId: "case1", engineOptOut: false });
  const r = await importCaseFromServiceNow(db, "UM0001234", "system:intake-poll");
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.alreadyImported, true);
  assert.equal(calls.restore, 1);
});

// The New case form calls createAndPlanCase directly — it never goes through import-service — so the
// flag has to be enforced at this layer or that path bypasses it entirely.
test("createAndPlanCase refuses to plan a case for an opted-out client", async () => {
  const repo = {
    clientForPlanning: async () => ({
      id: "c1", name: "Acme", slug: "acme", primaryDomain: "acme.com",
      emailDomain: null, emailDomainLocked: false, serviceNowSysId: null,
      engineOptOut: true,
      identity: null, personas: null, globals: null, globalsOffboard: null, locations: null, systems: [],
    }),
  } as unknown as CaseRepository;

  await assert.rejects(
    () => createAndPlanCase(repo, { clientSlug: "acme", action: "onboard", subject: null, serviceNowCaseNumber: null, payload: {}, dryRun: false }, "ui:new-case"),
    (e: unknown) => e instanceof EngineOptOutError && e.clientSlug === "acme"
  );
});
