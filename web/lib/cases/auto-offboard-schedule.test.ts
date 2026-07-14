import { test } from "node:test";
import assert from "node:assert/strict";
import { autoOffboardScheduleAt, offboardTargetResolved, engineOwnsSchedule, AUTO_SCHEDULE_ACTOR, AUTO_OFFBOARD_DELAY_MS, MAX_SCHEDULE_AHEAD_MS } from "./schedule";
import { normalizeIntake } from "../servicenow/intake-mapper";

// The whole risk in auto-scheduling an offboard is the TIMEZONE: fire an hour early and you cut
// someone's access while they're still working; fire late and a terminated user keeps their account.
// ServiceNow's u_end_date arrives as { value: <UTC>, display_value: <integration user's timezone> }.
// We must read `value` and treat it as UTC — never display_value, never local wall-clock.

// Minimal UM record: normalizeIntake only needs the fields it reads. subcategory 30100 = User
// Offboarding — the coded value that makes this an offboard (and so builds the offboard payload).
function umRecord(endDate: { value: string; display_value: string }) {
  return {
    number: { value: "UM0001234", display_value: "UM0001234" },
    subcategory: { value: "30100", display_value: "User Offboarding" },
    u_end_date: endDate,
  } as unknown as Parameters<typeof normalizeIntake>[0];
}

test("u_end_date is parsed as UTC from `value`, not from the display timezone", () => {
  // 17:00 UTC. A ServiceNow user in US/Eastern would SEE 13:00 — if we ever parsed display_value,
  // or treated the value as local time, the offboard would fire 4 hours off.
  const intake = normalizeIntake(umRecord({ value: "2026-07-20 17:00:00", display_value: "07/20/2026 13:00:00" }));
  assert.equal(intake.payload.offboardAt, "2026-07-20T17:00:00.000Z");
});

test("the offboard fires exactly 5 minutes after the termination instant", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const at = autoOffboardScheduleAt({ offboardAt: "2026-07-20T17:00:00.000Z" }, now);
  assert.equal(at?.toISOString(), "2026-07-20T17:05:00.000Z");
  assert.equal(at!.getTime() - Date.parse("2026-07-20T17:00:00.000Z"), AUTO_OFFBOARD_DELAY_MS);
});

// The instant is absolute, so it cannot be shifted by the server's timezone or by DST. Prove it by
// running the same computation under several TZs.
test("the fire time is identical regardless of the server's timezone (and across a DST boundary)", () => {
  const original = process.env.TZ;
  // 2026-11-01 is the US DST fall-back date — a local-time computation would drift by an hour.
  const cases = ["2026-07-20T17:00:00.000Z", "2026-11-01T06:30:00.000Z"];
  const results: string[] = [];
  try {
    for (const tz of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
      process.env.TZ = tz;
      for (const iso of cases) {
        const at = autoOffboardScheduleAt({ offboardAt: iso }, new Date("2026-01-01T00:00:00Z"));
        results.push(`${iso}=>${at?.toISOString()}`);
      }
    }
  } finally {
    process.env.TZ = original;
  }
  // every timezone produced the same two instants
  const perTz = [results.slice(0, 2), results.slice(2, 4), results.slice(4, 6), results.slice(6, 8)];
  for (const r of perTz) assert.deepEqual(r, perTz[0]);
  assert.equal(perTz[0][0], "2026-07-20T17:00:00.000Z=>2026-07-20T17:05:00.000Z");
  assert.equal(perTz[0][1], "2026-11-01T06:30:00.000Z=>2026-11-01T06:35:00.000Z");
});

// A date-only u_end_date carries no instant. Inventing one (midnight? 5pm? whose 5pm?) is exactly the
// guess that gets an offboard fired at the wrong hour — so we don't schedule at all.
test("a date-only u_end_date yields no instant and is never auto-scheduled", () => {
  const intake = normalizeIntake(umRecord({ value: "2026-07-20", display_value: "07/20/2026" }));
  assert.equal(intake.payload.offboardAt, null);
  assert.equal(autoOffboardScheduleAt({ offboardAt: null }, new Date("2026-07-01T00:00:00Z")), null);
  // the date-only value is still preserved for display
  assert.equal(intake.payload.dateOfOffboarding, "2026-07-20");
});

// A ticket filed AFTER the person left must not auto-run a destructive offboard with nobody watching
// — and on first deploy, every already-imported case with an old end date would otherwise fire at once.
test("a termination instant already in the past is NOT auto-scheduled (held for a human)", () => {
  const now = new Date("2026-07-20T18:00:00Z");
  assert.equal(autoOffboardScheduleAt({ offboardAt: "2026-07-20T17:00:00.000Z" }, now), null);
});

test("the 5-minute delay is applied before the past check (a termination 1 minute ago still waits)", () => {
  // termination at 17:00, now 17:01 -> fires at 17:05, which is still ahead: schedule it.
  const at = autoOffboardScheduleAt({ offboardAt: "2026-07-20T17:00:00.000Z" }, new Date("2026-07-20T17:01:00Z"));
  assert.equal(at?.toISOString(), "2026-07-20T17:05:00.000Z");
});

test("a missing or malformed offboardAt is ignored rather than throwing", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  assert.equal(autoOffboardScheduleAt({}, now), null);
  assert.equal(autoOffboardScheduleAt({ offboardAt: "not a date" }, now), null);
  assert.equal(autoOffboardScheduleAt({ offboardAt: 12345 }, now), null);
});

// A ServiceNow date-picker the requester never gave a time to stores 00:00:00. Scheduling off that
// fires at 00:05 UTC — the EVENING BEFORE the last working day in the Americas, cutting access
// mid-shift a day early. Midnight means "no time was given", not "terminate at midnight".
test("a midnight u_end_date is treated as no-time and is never auto-scheduled", () => {
  const intake = normalizeIntake(umRecord({ value: "2026-07-20 00:00:00", display_value: "07/20/2026 00:00:00" }));
  assert.equal(intake.payload.offboardAt, null);
  assert.equal(intake.payload.dateOfOffboarding, "2026-07-20"); // still shown to the operator
});

// Date.parse() reads a non-ISO datetime as SERVER-LOCAL per spec, so the fire instant would depend on
// the box's timezone. Only a strict Z-suffixed instant is accepted.
test("a non-ISO wire-format instant is refused rather than parsed as server-local time", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  assert.equal(autoOffboardScheduleAt({ offboardAt: "2026-07-20 17:00:00" }, now), null);
  assert.equal(autoOffboardScheduleAt({ offboardAt: "2026-07-20T17:00:00+05:30" }, now), null);
  assert.equal(autoOffboardScheduleAt({ offboardAt: "2026-07-20T17:00:00Z" }, now)?.toISOString(), "2026-07-20T17:05:00.000Z");
});

// A value carrying a timezone offset must not be silently read as UTC (that shifts the fire time).
test("a u_end_date with a trailing timezone offset yields no instant", () => {
  const intake = normalizeIntake(umRecord({ value: "2026-07-20T17:00:00+05:30", display_value: "07/20/2026 17:00:00" }));
  assert.equal(intake.payload.offboardAt, null);
});

// A mis-keyed year ("2126") would otherwise schedule a century out, and the UI would confidently say
// "runs <date>" — so the operator stops watching a leaver who is never actually offboarded.
test("an absurdly far-future termination is not scheduled (mis-keyed year)", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  assert.equal(autoOffboardScheduleAt({ offboardAt: "2126-07-20T17:00:00.000Z" }, now), null);
  // just inside the cap still schedules
  const justInside = new Date(now.getTime() + MAX_SCHEDULE_AHEAD_MS - 60 * 60_000).toISOString();
  assert.ok(autoOffboardScheduleAt({ offboardAt: justInside }, now));
});

// Auto-release removes the human who used to eyeball every offboard. If the intake never resolved WHO
// is leaving, the destructive steps would run against a blank identity with nobody watching.
test("offboardTargetResolved gates the schedule on the intake naming who is leaving", () => {
  assert.equal(offboardTargetResolved({ userToOffboard: "Jane Doe" }), true);
  assert.equal(offboardTargetResolved({ email: "jane@x.com" }), true);
  assert.equal(offboardTargetResolved({ userPrincipalName: "jane@x.com" }), true);
  assert.equal(offboardTargetResolved({}), false);
  assert.equal(offboardTargetResolved({ userToOffboard: "" }), false);
  assert.equal(offboardTargetResolved({ userToOffboard: "   " }), false);
});

// SECURITY: "not listed" means the requester TYPED a name instead of picking a real ServiceNow
// contact. `userToOffboard` is then a non-empty *unverified string*, so a plain is-it-blank check
// waves it through — and the M365/Zoom/xMatters offboard lanes resolve a leaver by DISPLAY NAME when
// there's no UPN. A typo or a namesake therefore matches a REAL, CURRENT employee, and the case would
// auto-release on the u_end_date and disable them unattended. A free-typed name must get a human.
test("a 'not listed' (free-typed) offboard target never auto-schedules", () => {
  assert.equal(
    offboardTargetResolved({ userToOffboard: "Jane Smith", notListedUser: true }),
    false,
    "a typed name is not an identity — it must not auto-release a destructive offboard"
  );
  // Even with an email present, the not-listed flag means the requester didn't pick a real contact.
  assert.equal(offboardTargetResolved({ userToOffboard: "Jane Smith", email: "j@x.com", notListedUser: true }), false);
});

test("an offboard against a real ServiceNow contact still auto-schedules", () => {
  assert.equal(offboardTargetResolved({ userToOffboard: "Jane Smith", notListedUser: false }), true);
  assert.equal(offboardTargetResolved({ userToOffboard: "Jane Smith" }), true); // flag absent = a resolved reference
  assert.equal(offboardTargetResolved({ userPrincipalName: "jane@x.com" }), true);
});

test("a blank target still never auto-schedules", () => {
  assert.equal(offboardTargetResolved({}), false);
  assert.equal(offboardTargetResolved({ userToOffboard: "   " }), false);
});

// SECURITY: a ServiceNow rescan re-derives the scheduled time from the refreshed ticket. It must only
// do that for a schedule the ENGINE set. `pausedReason: "scheduled"` is ALSO what the operator's own
// schedule button writes, so keying on it alone would silently overwrite a human's deliberate choice —
// e.g. an operator holding a leaver's access open for a handover — and snap the teardown back to the
// original date. That is an unattended offboard, days early, against someone still employed.
test("a rescan may recompute the ENGINE's own schedule", () => {
  assert.equal(engineOwnsSchedule("scheduled", AUTO_SCHEDULE_ACTOR), true);
  // Legacy rows predate the provenance field; treat as engine-owned.
  assert.equal(engineOwnsSchedule("scheduled", null), true);
});

test("a rescan must NOT overwrite a schedule a human chose", () => {
  assert.equal(engineOwnsSchedule("scheduled", "ops@core.tech"), false);
  assert.equal(engineOwnsSchedule("scheduled", "someone.else@core.tech"), false);
});

test("a case that isn't on a scheduled hold is never rescheduled by a rescan", () => {
  for (const reason of ["review", "needs_info", "creds", "operator", null]) {
    assert.equal(engineOwnsSchedule(reason, AUTO_SCHEDULE_ACTOR), false, `pausedReason=${reason} must not be rescheduled`);
  }
});
