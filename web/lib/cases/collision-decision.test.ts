import { test } from "node:test";
import assert from "node:assert/strict";
import { collisionDecision, decisionTargets } from "./collision-decision";

// FR #0000175: Adopt looped — the answer said "adopt" but not which account, and only reached the
// M365 jobs even when another step asked.

test("adopt carries the account the operator confirmed", () => {
  assert.deepEqual(collisionDecision("adopt", " JDoe@x.com "), { usernameCollisionPolicy: "adopt", usernameCollisionAdoptUpn: "JDoe@x.com" });
});

test("adopt with no account is still accepted (same-name adopt), and 'new' clears a confirmed account", () => {
  assert.deepEqual(collisionDecision("adopt", null), { usernameCollisionPolicy: "adopt", usernameCollisionAdoptUpn: null });
  assert.deepEqual(collisionDecision("new", "jdoe@x.com"), { usernameCollisionPolicy: "new", usernameCollisionAdoptUpn: null });
});

test("anything else is not a decision, and a malformed account is refused", () => {
  assert.equal(collisionDecision(undefined, "jdoe@x.com"), null);
  assert.equal(collisionDecision("ask", null), null);
  assert.deepEqual(collisionDecision("adopt", "not an email"), { error: "the account to adopt must be an email address" });
  assert.deepEqual(collisionDecision("adopt", "a@b.com | upn=x"), { error: "the account to adopt must be an email address" });
});

test("the answer also lands on the step that asked (AD / Google), once", () => {
  const m365 = [{ id: "m", systemKey: "m365" }, { id: "e", systemKey: "entra" }];
  assert.deepEqual(decisionTargets(m365, { id: "a", systemKey: "active-directory" }).map((j) => j.id), ["m", "e", "a"]);
  assert.deepEqual(decisionTargets(m365, { id: "m", systemKey: "m365" }).map((j) => j.id), ["m", "e"]);
  assert.deepEqual(decisionTargets([], { id: "g", systemKey: "google-workspace" }).map((j) => j.id), ["g"]);
  assert.deepEqual(decisionTargets(m365, null).map((j) => j.id), ["m", "e"]);
});
