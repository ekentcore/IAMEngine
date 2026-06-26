import { test } from "node:test";
import assert from "node:assert/strict";
import { actionLabel } from "./action-labels";

test("known actions get explicit English labels", () => {
  assert.equal(actionLabel("auth.login.sso"), "SSO Login");
  assert.equal(actionLabel("auth.login"), "Login");
  assert.equal(actionLabel("servicenow.sync"), "ServiceNow Sync");
  assert.equal(actionLabel("job.run_single"), "Single Step Run");
});

test("unknown actions are prettified with acronyms preserved", () => {
  assert.equal(actionLabel("foo.bar_baz"), "Foo Bar Baz");
  assert.equal(actionLabel("client.m365.thing"), "Client M365 Thing");
  assert.equal(actionLabel("some.api.call"), "Some API Call");
});
