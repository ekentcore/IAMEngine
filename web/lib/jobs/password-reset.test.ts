import { test } from "node:test";
import assert from "node:assert/strict";
import { pickResetSourceJob } from "./password-reset";

test("prefers the AD line and falls back through cloud lanes", () => {
  assert.equal(pickResetSourceJob([
    { id: "j2", systemKey: "m365", status: "pending" },
    { id: "j1", systemKey: "active-directory", status: "pending" },
  ]), "j1");
  assert.equal(pickResetSourceJob([{ id: "j3", systemKey: "mimecast", status: "pending" }]), null);
});
