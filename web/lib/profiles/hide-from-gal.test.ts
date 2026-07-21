import { test } from "node:test";
import assert from "node:assert/strict";
import { hideFromGalOptedOut, adLaneHidesViaAttribute } from "./hide-from-gal";

test("hideFromGalOptedOut: is false when the key is absent (default-on)", () => {
  assert.equal(hideFromGalOptedOut({}), false);
  assert.equal(hideFromGalOptedOut(null), false);
  assert.equal(hideFromGalOptedOut(undefined), false);
});

test("hideFromGalOptedOut: is false when hideFromGal is truthy", () => {
  assert.equal(hideFromGalOptedOut({ hideFromGal: true }), false);
  assert.equal(hideFromGalOptedOut({ hideFromGal: { value: true } }), false);
});

test("hideFromGalOptedOut: is true only for an explicit no", () => {
  assert.equal(hideFromGalOptedOut({ hideFromGal: false }), true);
  assert.equal(hideFromGalOptedOut({ hideFromGal: "false" }), true);
  assert.equal(hideFromGalOptedOut({ hideFromGal: "off" }), true);
  assert.equal(hideFromGalOptedOut({ hideFromGal: { value: false } }), true);
});

test("hideFromGalOptedOut: reads the hideFromGAL casing variant too", () => {
  assert.equal(hideFromGalOptedOut({ hideFromGAL: false }), true);
  assert.equal(hideFromGalOptedOut({ hideFromGAL: true }), false);
});

test("adLaneHidesViaAttribute: is true only when a concrete attribute is present", () => {
  assert.equal(adLaneHidesViaAttribute({ hideFromGal: { attribute: "msExchHideFromAddressLists", value: "TRUE" } }), true);
  assert.equal(adLaneHidesViaAttribute({ hideFromGAL: { attribute: "msDS-cloudExtensionAttribute1", value: "HideFromGAL" } }), true);
});

test("adLaneHidesViaAttribute: is false for bare true, opt-out, or absence", () => {
  assert.equal(adLaneHidesViaAttribute({ hideFromGal: true }), false);
  assert.equal(adLaneHidesViaAttribute({ hideFromGal: false }), false);
  assert.equal(adLaneHidesViaAttribute({ hideFromGal: { value: true } }), false);
  assert.equal(adLaneHidesViaAttribute({}), false);
  assert.equal(adLaneHidesViaAttribute(null), false);
});
