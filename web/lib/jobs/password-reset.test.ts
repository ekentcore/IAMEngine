import { test } from "node:test";
import assert from "node:assert/strict";
import { pickResetSourceJob } from "./password-reset";

const AD = { id: "j1", systemKey: "active-directory", status: "pending" };
const M365 = { id: "j2", systemKey: "m365", status: "pending" };
const ENTRA = { id: "j4", systemKey: "entra", status: "pending" };
const GOOGLE = { id: "j5", systemKey: "google-workspace", status: "pending" };

test("prefers the AD line and falls back through cloud lanes", () => {
  assert.equal(pickResetSourceJob([M365, AD]), "j1");
  assert.equal(pickResetSourceJob([{ id: "j3", systemKey: "mimecast", status: "pending" }]), null);
});

// FR #0000080. The order used to be a single hardcoded list with google-workspace LAST, applied to
// every client regardless of backbone. A Google-backbone client commonly ALSO has an M365 lane (Google
// for mail, M365 for the Office apps), so the reset landed in the wrong directory — the operator reset
// a password in a tenant the user doesn't sign in to, and the real one was never changed.
test("a Google-backbone client resets in Google, even when an M365 lane is planned", () => {
  assert.equal(pickResetSourceJob([M365, GOOGLE], "google"), "j5");
  assert.equal(pickResetSourceJob([ENTRA, M365, GOOGLE], "google"), "j5");
});

test("every other backbone keeps the on-prem-first order exactly as before", () => {
  for (const backbone of ["entra", "ad_synced", "ad_standalone", null, undefined]) {
    assert.equal(pickResetSourceJob([GOOGLE, M365, AD], backbone), "j1", `backbone ${backbone}: AD wins`);
    assert.equal(pickResetSourceJob([GOOGLE, M365], backbone), "j2", `backbone ${backbone}: m365 beats google`);
  }
});

// AD stays first even for a Google backbone, and this is deliberate rather than an oversight. A client
// running an AD lane is on-prem-mastered: the directory above it is a synced copy, so a reset written
// to the copy is refused or silently overwritten by the next sync cycle. The backbone reorders the
// CLOUD lanes among themselves — which is the whole of the reported bug — and never displaces AD.
test("AD still wins for a Google backbone — an on-prem master is not bypassed", () => {
  assert.equal(pickResetSourceJob([GOOGLE, AD], "google"), "j1");
  assert.equal(pickResetSourceJob([GOOGLE, M365, AD], "google"), "j1");
});

test("a Google-backbone client with no Google lane still finds a cloud lane", () => {
  assert.equal(pickResetSourceJob([M365], "google"), "j2");
  assert.equal(pickResetSourceJob([ENTRA], "google"), "j4");
});

test("no resettable system planned at all returns null, whatever the backbone", () => {
  const none = [{ id: "j9", systemKey: "mimecast", status: "pending" }];
  assert.equal(pickResetSourceJob(none, "google"), null);
  assert.equal(pickResetSourceJob(none, "entra"), null);
});
