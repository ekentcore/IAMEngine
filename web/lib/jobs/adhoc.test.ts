import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { insertStepSequence, isAdhocSystemKey, SPANNING_FORCE_SYNC_KEY, MIMECAST_CONSOLE_SETUP_KEY } from "./adhoc";

// A minimal stand-in for the Prisma transaction client: only the three job methods insertStepSequence
// touches, plus a record of the shift it performed so we can assert on it.
function mockTx(opts: { closingSeq: number | null; maxSeq: number | null }) {
  const updateManyCalls: { where: unknown; data: unknown }[] = [];
  const tx = {
    job: {
      findFirst: async () => (opts.closingSeq === null ? null : { sequence: opts.closingSeq }),
      aggregate: async () => ({ _max: { sequence: opts.maxSeq } }),
      updateMany: async (args: { where: unknown; data: unknown }) => {
        updateManyCalls.push(args);
        return { count: 1 };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, updateManyCalls };
}

test("insertStepSequence: no case-resolution step -> plain append at max+1, no shift", async () => {
  const { tx, updateManyCalls } = mockTx({ closingSeq: null, maxSeq: 6 });
  const seq = await insertStepSequence(tx, "case-1");
  assert.equal(seq, 7);
  assert.equal(updateManyCalls.length, 0); // nothing to push down
});

test("insertStepSequence: empty case -> append at 1", async () => {
  const { tx } = mockTx({ closingSeq: null, maxSeq: null });
  assert.equal(await insertStepSequence(tx, "case-1"), 1);
});

test("insertStepSequence: inserts at case-resolution's slot and pushes it (and anything after) down", async () => {
  // case-resolution at seq 7 (the last planned step). The new step takes seq 7; case-resolution -> 8.
  const { tx, updateManyCalls } = mockTx({ closingSeq: 7, maxSeq: 7 });
  const seq = await insertStepSequence(tx, "case-1");
  assert.equal(seq, 7); // the new step lands ABOVE case-resolution
  assert.equal(updateManyCalls.length, 1);
  assert.deepEqual(updateManyCalls[0], {
    where: { caseRequestId: "case-1", sequence: { gte: 7 } },
    data: { sequence: { increment: 1 } },
  });
});

test("adhoc keys still classify force-sync", () => {
  assert.equal(isAdhocSystemKey(SPANNING_FORCE_SYNC_KEY), true);
  assert.equal(isAdhocSystemKey("m365"), false);
});

test("the Mimecast console browser key is an ad-hoc key (never fails/gates a case)", () => {
  assert.equal(MIMECAST_CONSOLE_SETUP_KEY, "mimecast-console-setup");
  assert.equal(isAdhocSystemKey(MIMECAST_CONSOLE_SETUP_KEY), true);
});
