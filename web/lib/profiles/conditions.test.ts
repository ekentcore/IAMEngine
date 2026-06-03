import { test } from "node:test";
import assert from "node:assert/strict";
import { evalCondition, interpolate, getPath } from "./conditions";

const ctx = {
  first: "John", last: "Doe", username: "john.doe", upn: "john.doe@core.tech", domain: "core.tech",
  title: "Remote Support Engineer", department: "Remote Support", employmentType: "Full-Time",
  startDate: "2026-06-15", extension: "1234",
  role: { name: "Engineer" },
  location: { name: "CA", timezone: "US/Pacific" },
  country: { short: "US", name: "United States", code: "1" },
  avd: true, perimeter: false,
};

test("getPath resolves dotted paths and returns undefined for misses", () => {
  assert.equal(getPath(ctx, "country.short"), "US");
  assert.equal(getPath(ctx, "title"), "Remote Support Engineer");
  assert.equal(getPath(ctx, "location.nope"), undefined);
  assert.equal(getPath(ctx, "nope.nope"), undefined);
});

test("evalCondition: empty/absent is always true", () => {
  assert.equal(evalCondition("", ctx), true);
  assert.equal(evalCondition(undefined, ctx), true);
  assert.equal(evalCondition("   ", ctx), true);
});

test("evalCondition: boolean term", () => {
  assert.equal(evalCondition("avd == true", ctx), true);
  assert.equal(evalCondition("perimeter == true", ctx), false);
  assert.equal(evalCondition("perimeter == false", ctx), true);
  assert.equal(evalCondition("avd != false", ctx), true);
});

test("evalCondition: string equality is case-insensitive (PowerShell -eq)", () => {
  assert.equal(evalCondition("location.name == CA", ctx), true);
  assert.equal(evalCondition("location.name == ca", ctx), true);
  assert.equal(evalCondition("country.short == US", ctx), true);
  assert.equal(evalCondition("country.short != CA", ctx), true);
  assert.equal(evalCondition("employmentType == Part-Time", ctx), false);
});

test("evalCondition: quoted values keep spaces", () => {
  assert.equal(evalCondition('department == "Remote Support"', ctx), true);
  assert.equal(evalCondition("department == 'Remote Support'", ctx), true);
});

test("evalCondition: ~= is a (case-insensitive) regex match", () => {
  assert.equal(evalCondition("title ~= ^Remote Support", ctx), true);
  assert.equal(evalCondition("title ~= engineer$", ctx), true);
  assert.equal(evalCondition("title ~= ^Manager", ctx), false);
});

test("evalCondition: in [list]", () => {
  assert.equal(evalCondition("title in [Project Manager, Remote Support Engineer]", ctx), true);
  assert.equal(evalCondition("location.name in [NY, TX]", ctx), false);
  assert.equal(evalCondition("country.short in [US, CA, GB]", ctx), true);
});

test("evalCondition: && requires all, || requires any, && binds tighter", () => {
  assert.equal(evalCondition("country.short == US && employmentType == Full-Time", ctx), true);
  assert.equal(evalCondition("country.short == US && employmentType == Part-Time", ctx), false);
  assert.equal(evalCondition("location.name == NY || country.short == US", ctx), true);
  // a || b && c  ==  a || (b && c)
  assert.equal(evalCondition("location.name == NY || country.short == US && avd == true", ctx), true);
  assert.equal(evalCondition("location.name == NY || country.short == GB && avd == true", ctx), false);
});

test("interpolate: replaces {tokens} incl. dotted paths", () => {
  assert.equal(interpolate("{first}.{last}", ctx), "John.Doe");
  assert.equal(interpolate("{username}@{domain}", ctx), "john.doe@core.tech");
  assert.equal(interpolate("OU={location.name},{country.short}", ctx), "OU=CA,US");
});

test("interpolate: computed initials + legacy <username> alias", () => {
  assert.equal(interpolate("{firstInitial}{last}", ctx), "JDoe");
  assert.equal(interpolate("CN=<username>", ctx), "CN=john.doe");
});

test("interpolate: an unknown token is left literal (so a typo is visible)", () => {
  assert.equal(interpolate("{first}.{nope}", ctx), "John.{nope}");
});
