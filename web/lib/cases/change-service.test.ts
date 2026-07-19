import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeDiffs, confirmChangeCase } from "./change-service";
import type { CaseRepository } from "./repository";

const client = {
  systems: [
    { systemKey: "active-directory", mode: "api", secretNames: ["ad-dc"], requiresApproval: false },
    { systemKey: "m365", mode: "api", secretNames: ["m365-admin"], requiresApproval: false },
  ],
  personas: null, globals: null, locations: null,
};

test("buildChangeDiffs: adhoc payload maps deltas onto directory diffs", () => {
  const diffs = buildChangeDiffs(client as never, {
    userToChange: "Jane Doe",
    changeKind: "adhoc",
    deltas: [{ op: "add", target: "group", value: "Sales" }],
  });
  assert.deepEqual(diffs.find((d) => d.systemKey === "active-directory")!.add, ["Sales"]);
});

test("buildChangeDiffs: mover with no personas yields empty adds (no target rules), scoped removeGroups empty", () => {
  const diffs = buildChangeDiffs(client as never, {
    userToChange: "Jane Doe",
    changeKind: "mover",
    toPersona: "Sales",
    removalMode: "scoped",
  });
  // no persona rules configured on this bare client → nothing to add or remove
  assert.deepEqual(diffs.find((d) => d.systemKey === "active-directory")!.add, []);
});

// ── mover excludes Exchange (v1 decision) ─────────────────────────────────────────────────────
// Exchange only handles DLs/shared mailboxes in the Change lane, never security groups — so a
// mover (which targets group/OU/license/attrs) must never produce an exchange diff/job, even when
// the client has an exchange system. Ad-hoc dl/sharedMailbox deltas still target exchange.
const clientWithExchange = {
  systems: [
    { systemKey: "active-directory", mode: "api", secretNames: ["ad-dc"], requiresApproval: false },
    { systemKey: "m365", mode: "api", secretNames: ["m365-admin"], requiresApproval: false },
    { systemKey: "exchange", mode: "api", secretNames: ["m365-admin"], requiresApproval: false },
  ],
  personas: {
    Sales: {
      systems: {
        "active-directory": { groups: ["Sales-AD"] },
        m365: { groups: ["Sales-365"] },
      },
    },
  },
  globals: null,
  locations: null,
};

test("buildChangeDiffs: mover excludes exchange from the diffs entirely, even when the client has it", () => {
  const diffs = buildChangeDiffs(clientWithExchange as never, {
    userToChange: "Jane Doe",
    changeKind: "mover",
    toPersona: "Sales",
    removalMode: "scoped",
  });
  assert.equal(diffs.some((d) => d.systemKey === "exchange"), false);
  // the other directories are still present
  assert.ok(diffs.some((d) => d.systemKey === "active-directory"));
  assert.ok(diffs.some((d) => d.systemKey === "m365"));
});

test("buildChangeDiffs: adhoc dl delta still targets exchange (ad-hoc keeps exchange)", () => {
  const diffs = buildChangeDiffs(clientWithExchange as never, {
    userToChange: "Jane Doe",
    changeKind: "adhoc",
    deltas: [{ op: "add", target: "dl", value: "sales@x.com" }],
  });
  assert.deepEqual(diffs.find((d) => d.systemKey === "exchange")!.namedGroups, ["sales@x.com"]);
});

// ── confirmChangeCase refuses a wrong-kind case (PR: change-mover guard) ────────────────────────
// A fat-fingered/wrong case id to POST /change/confirm must never flip an onboard/offboard case to
// "change" and replace its jobs. Guard on repo.replanInputs().action BEFORE any replan happens.
test("confirmChangeCase throws on a non-change case and never calls replanCaseJobs", async () => {
  let replanCalled = false;
  const repo = {
    async replanInputs() {
      return {
        serviceNowCaseNumber: null,
        action: "onboard",
        payload: { userToChange: "Jane Doe", changeKind: "mover", toPersona: "Sales" },
        emailDomainOverride: null,
        client: {
          id: "c1", slug: "acme", primaryDomain: "acme.com",
          emailDomain: null, emailDomainLocked: false, serviceNowSysId: null,
          identity: {}, personas: null, globals: null, globalsOffboard: null, locations: null, systems: [],
          notNeededSecrets: [], wiredOptionalSecrets: [],
        },
        started: false,
      };
    },
    async replanCaseJobs() {
      replanCalled = true;
      return { mode: "full" as const, kept: 0, added: 0, rerun: 0 };
    },
    async setHold() {},
    async writeAudit() {},
  } as unknown as CaseRepository;

  await assert.rejects(() => confirmChangeCase(repo, "case-1", "scoped", "test"));
  assert.equal(replanCalled, false, "replanCaseJobs must not run for a non-change case");
});
