import { test } from "node:test";
import assert from "node:assert/strict";
import { caseUserName } from "./user-name";

test("the display name wins — it is what intake assembles for both onboards and offboards", () => {
  assert.equal(caseUserName({ displayName: "Jane Doe", firstName: "Janet", lastName: "Doe", userPrincipalName: "jdoe@acme.com" }), "Jane Doe");
});

test("an onboard with no display name uses first + last, or whichever half exists", () => {
  assert.equal(caseUserName({ firstName: "Jane", lastName: "Doe" }), "Jane Doe");
  assert.equal(caseUserName({ firstName: "Cher" }), "Cher");
});

test("an offboard falls back to the picker text, then the account identifiers", () => {
  assert.equal(caseUserName({ userToOffboard: "Eve Gonzalez", userPrincipalName: "eve@bpc.com" }), "Eve Gonzalez");
  assert.equal(caseUserName({ userPrincipalName: "eve@bpc.com" }), "eve@bpc.com");
  assert.equal(caseUserName({ email: "eve@bpc.com" }), "eve@bpc.com");
});

test("blank strings are not names, and a payload naming nobody is null (the caller shows the subject)", () => {
  assert.equal(caseUserName({ displayName: "  ", firstName: "", userToOffboard: "Sam Roe" }), "Sam Roe");
  assert.equal(caseUserName({}), null);
  assert.equal(caseUserName(null), null);
  assert.equal(caseUserName({ displayName: 42 }), null);
});
