import { test } from "node:test";
import assert from "node:assert/strict";
import { readDefaultPassword } from "./default-password";

test("a fixed default is read from config.onboard.initialPassword", () => {
  assert.deepEqual(readDefaultPassword({ onboard: { initialPassword: "Welcome2Acme!" } }), { mode: "fixed", value: "Welcome2Acme!" });
});

test("a Delinea-backed default surfaces only its reference, never a value", () => {
  assert.deepEqual(readDefaultPassword({ onboard: { initialPasswordSecret: "default-password", initialPassword: "stale" } }), { mode: "secret", secretName: "default-password" });
});

test("generate mode, blank values and missing config have no default", () => {
  assert.equal(readDefaultPassword({ onboard: {} }), null);
  assert.equal(readDefaultPassword({ onboard: { initialPassword: "   " } }), null);
  assert.equal(readDefaultPassword(null), null);
  assert.equal(readDefaultPassword({ onboard: { initialPassword: 42 } }), null);
});
