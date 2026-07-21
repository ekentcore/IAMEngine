import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIntake } from "./intake-mapper";
import type { SnUserMgmtRecord } from "./intake";

function record(over: Partial<Record<string, { value: string; display_value: string }>>): SnUserMgmtRecord {
  const base: Record<string, { value: string; display_value: string }> = {
    number: { value: "UM1", display_value: "UM1" },
    subcategory: { value: "New User Request", display_value: "New User Request" },
    u_first: { value: "Kate", display_value: "Kate" },
    u_last: { value: "Doe", display_value: "Doe" },
    account: { value: "acct-sys-id", display_value: "Shawmut" },
    opened_by: { value: "user-sys-id-123", display_value: "Angie Shropshire" },
    contact: { value: "7750e1e447bdf29c3c5e88f4116d4393", display_value: "Angie Shropshire" },
  };
  return { ...base, ...over } as SnUserMgmtRecord;
}

test("onboard payload captures requester sys_ids", () => {
  const n = normalizeIntake(record({}));
  assert.equal(n.payload.requestedByContactSysId, "7750e1e447bdf29c3c5e88f4116d4393");
  assert.equal(n.payload.openedBySysId, "user-sys-id-123");
  assert.equal(n.payload.requestedBy, "Angie Shropshire"); // display name still present
});

test("absent requester fields → null, no throw", () => {
  const n = normalizeIntake(record({ contact: undefined, opened_by: undefined }));
  assert.equal(n.payload.requestedByContactSysId, null);
  assert.equal(n.payload.openedBySysId, null);
});
