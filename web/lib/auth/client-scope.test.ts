import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVisibleClientIds, isClientVisible, scopeAllows, clientIdWhere } from "./client-scope";

// Roster used across cases: A and B are normal; R and S are restricted (internal-only).
const ROSTER = [
  { id: "A", restricted: false },
  { id: "B", restricted: false },
  { id: "R", restricted: true },
  { id: "S", restricted: true },
];

function visible(mode: "all" | "only" | "exclude", scopeIds: string[] = [], grantIds: string[] = []) {
  return computeVisibleClientIds({ mode, scopeIds, grantIds, clients: ROSTER }).sort();
}

test("all: sees every non-restricted client; restricted hidden without a grant", () => {
  assert.deepEqual(visible("all"), ["A", "B"]);
});

test("all: a granted restricted client becomes visible (others stay hidden)", () => {
  assert.deepEqual(visible("all", [], ["R"]), ["A", "B", "R"]);
});

test("all: granting both restricted clients shows the whole roster", () => {
  assert.deepEqual(visible("all", [], ["R", "S"]), ["A", "B", "R", "S"]);
});

test("only: an empty allowlist sees nothing", () => {
  assert.deepEqual(visible("only", []), []);
});

test("only: sees exactly the allowlist, excluding non-listed normal clients", () => {
  assert.deepEqual(visible("only", ["A"]), ["A"]);
});

test("only: a restricted client in the allowlist is thereby granted (no separate grant needed)", () => {
  assert.deepEqual(visible("only", ["A", "R"]), ["A", "R"]);
});

test("only: a restricted client NOT in the allowlist stays hidden", () => {
  assert.deepEqual(visible("only", ["A"], ["R"]), ["A"]); // grant is irrelevant in only-mode
});

test("exclude: sees all non-restricted except the deny list; restricted hidden without a grant", () => {
  assert.deepEqual(visible("exclude", ["B"]), ["A"]);
});

test("exclude: a granted restricted client is visible unless it's also on the deny list", () => {
  assert.deepEqual(visible("exclude", ["B"], ["R"]), ["A", "R"]);
  assert.deepEqual(visible("exclude", ["B", "R"], ["R"]), ["A"]); // deny wins over grant
});

test("exclude with an empty deny list still hides ungranted restricted clients", () => {
  assert.deepEqual(visible("exclude", []), ["A", "B"]);
});

test("isClientVisible: restricted gate applies to all/exclude but only-list overrides it", () => {
  const empty = new Set<string>();
  assert.equal(isClientVisible("all", { id: "R", restricted: true }, empty, empty), false);
  assert.equal(isClientVisible("all", { id: "R", restricted: true }, empty, new Set(["R"])), true);
  assert.equal(isClientVisible("only", { id: "R", restricted: true }, new Set(["R"]), empty), true);
});

test("scopeAllows: null scope (super/auth-off) allows anything; array scope checks membership", () => {
  assert.equal(scopeAllows(null, "anything"), true);
  assert.equal(scopeAllows(["A"], "A"), true);
  assert.equal(scopeAllows(["A"], "B"), false);
  assert.equal(scopeAllows(["A"], null), false);
  assert.equal(scopeAllows([], "A"), false);
});

test("clientIdWhere: null scope yields no filter; array yields an `in` clause", () => {
  assert.equal(clientIdWhere(null), undefined);
  assert.deepEqual(clientIdWhere(["A", "B"]), { in: ["A", "B"] });
});
