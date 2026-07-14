// Map a ServiceNow onboarding INCIDENT (record-producer variables) to the same NormalizedIntake
// shape the UM mapper produces, so it flows through the identical planning path. No I/O; unit-tested.
import { incidentAction, type SnIncidentRecord } from "./incident-intake";
import type { NormalizedIntake } from "./intake-mapper";

type Cell = { value?: string; display_value?: string } | string | null | undefined;

// raw value / readable display for a column OR a `variables.<name>` dotted key.
function raw(r: SnIncidentRecord, key: string): string {
  const c = r[key] as Cell;
  if (c == null) return "";
  if (typeof c === "string") return c.trim();
  return String(c.value ?? "").trim();
}
function disp(r: SnIncidentRecord, key: string): string {
  const c = r[key] as Cell;
  if (c == null) return "";
  if (typeof c === "string") return c.trim();
  return String(c.display_value ?? c.value ?? "").trim();
}
const v = (r: SnIncidentRecord, name: string) => raw(r, `variables.${name}`);
const vd = (r: SnIncidentRecord, name: string) => disp(r, `variables.${name}`);
const orNull = (s: string) => (s === "" ? null : s);

// "Full-Time Employee" / "fte" -> "Full-Time"; "Part-Time…" -> "Part-Time"; contractor/temp likewise.
function normalizeEmploymentType(value: string, display: string): string | null {
  const s = `${value} ${display}`.toLowerCase();
  if (/full.?time|\bfte\b/.test(s)) return "Full-Time";
  if (/part.?time|\bpte\b/.test(s)) return "Part-Time";
  if (/contractor|contract|consultant|1099/.test(s)) return "Contractor";
  if (/\btemp\b|temporary|intern/.test(s)) return "Temp";
  return orNull(display || value);
}

// Pull a "mirror <Person Name>" reference user out of free text (the incident producer has no
// structured mirror variable — it's written in the shipping note / special requests).
export function extractMirrorUser(text: string): string | null {
  if (!text) return null;
  // First name token is 2+ letters; trailing tokens may be a single initial (e.g. "Q"). A period
  // ends the name (so "…Holleran. Thank you" stops at "Holleran"), since \s+ can't cross it.
  const m = text.match(/mirror(?:\s+(?:the\s+)?(?:access|permissions?|groups?|rights?))?(?:\s+(?:of|from|to|like|after|as))?\s+([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]*){1,2})/);
  return m ? m[1].replace(/[.\s]+$/, "").trim() : null;
}

function onboardPayload(r: SnIncidentRecord): Record<string, unknown> {
  // Producer variables are usually empty on these internal incidents, so fall back to the title
  // ("Onboarding - 07/13/2026 - Drew Dirienzo") and the notes' first line for the name.
  const titleName = nameFromTitle(disp(r, "short_description")) ?? nameFromNotes(v(r, "description"));
  const titleTokens = (titleName ?? "").split(/\s+/).filter(Boolean);
  const firstName = v(r, "u_first_name") || titleTokens[0] || "";
  const lastName = v(r, "u_last_name") || (titleTokens.length > 1 ? titleTokens.slice(1).join(" ") : "");
  const title = v(r, "u_title");
  // Office location proper, falling back to the workspace location (e.g. "Remote (US)").
  const officeLocation = vd(r, "u_office_location") || vd(r, "u_workspace_location");
  const shipping = v(r, "u_shipping");
  const notes = v(r, "description");
  const cell = vd(r, "u_equip_amex").toLowerCase(); // producer label: "User need a Cell Phone"

  return {
    firstName,
    lastName,
    nickname: orNull(v(r, "u_nickname")),
    displayName: [firstName, lastName].filter(Boolean).join(" ") || titleName || null,
    jobTitle: orNull(title),
    title: orNull(title),
    department: orNull(vd(r, "u_department")),
    officeLocation: orNull(officeLocation),
    workspaceLocation: orNull(vd(r, "u_workspace_location")),
    employmentType: normalizeEmploymentType(v(r, "u_employment_type"), vd(r, "u_employment_type")),
    managerName: orNull(vd(r, "u_hiring_manager")), // readable name, not the sys_id
    startDate: orNull(v(r, "u_start_date") || dateFromTitle(disp(r, "short_description")) || ""),
    personalEmail: orNull(v(r, "u_personal_email")),
    personalPhone: orNull(v(r, "u_phone_number")),
    mobilePhone: orNull(v(r, "u_phone_number")),
    recruiter: orNull(vd(r, "u_recruiter")),
    costCenter: orNull(v(r, "cost_center")),
    cellPhoneRequired: cell === "" ? null : /^y(es)?$/.test(cell),
    // "mirror <user>" access model (incident-specific): copy a reference user's group memberships.
    mirrorPermissionsFromUser: extractMirrorUser(shipping) ?? extractMirrorUser(notes),
    requestedBy: orNull(disp(r, "opened_by")),
    shippingInstructions: orNull(shipping),
    description: orNull(notes),
    // India/Aadhaar legal-name variants when present (Podshore hires).
    givenName: orNull(v(r, "given_name")),
    familyName: orNull(v(r, "family_name")),
  };
}

// First non-empty value among several candidate producer variables (forms vary by revision).
function firstVar(r: SnIncidentRecord, names: string[], display = false): string {
  for (const n of names) {
    const value = display ? vd(r, n) : v(r, n);
    if (value) return value;
  }
  return "";
}

// Urgency/timing words that appear as their OWN segment in offboard titles ("Offboarding - Neil
// Richter - Immediate") — they're not the person's name.
const TIMING_WORD = /^(immediate(ly)?|asap|urgent|rush|priority|now|today|tonight|eod|cob|end of (day|business)|effective.*)$/i;
const looksLikeName = (s: string) => /^[A-Z][A-Za-z'’.-]*(\s+[A-Z][A-Za-z'’.-]*)+$/.test(s); // 2+ capitalized tokens
const DATE_SEG = /^\d{1,4}[/.-]\d{1,2}([/.-]\d{1,4})?$/; // a date-looking title segment, e.g. "07/13/2026"

// Internal incidents carry NO producer variables — the person's name lives in the title
// ("Onboarding - 07/13/2026 - Drew Dirienzo", "Offboarding - Neil Richter - Immediate", "OFFB - Katie
// Butzer - 06/30"). Drop the action word / date / urgency segments and PREFER the one that looks like a
// person name (2+ capitalized tokens); fall back to the last leftover segment.
function nameFromTitle(sd: string): string | null {
  if (!sd) return null;
  const segs = sd.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  const candidates = segs.filter((s) => !/^\d/.test(s) && !/(?:on|off)-?board/i.test(s) && !TIMING_WORD.test(s));
  return candidates.find(looksLikeName) ?? candidates[candidates.length - 1] ?? null;
}

// The first date-looking segment of a title ("Onboarding - 07/13/2026 - Drew" → "07/13/2026").
function dateFromTitle(sd: string): string | null {
  return sd.split(/\s+[-–—]\s+/).map((s) => s.trim()).find((s) => DATE_SEG.test(s)) ?? null;
}

// First line of the notes when it reads like a person's (legal) name — internal onboards put it there
// ("Andrew Dirienzo\n74 S Transithill Dr…"). Last-resort name source.
function nameFromNotes(notes: string): string | null {
  const first = (notes.split(/\r?\n/)[0] ?? "").trim();
  return looksLikeName(first) ? first : null;
}

// The departing user's full name: prefer explicit name variables, else parse the short description.
function offboardName(r: SnIncidentRecord): string {
  const explicit = firstVar(r, ["u_full_name", "u_display_name", "u_name", "u_user", "u_employee", "u_offboard_user"], true)
    || [v(r, "u_first_name"), v(r, "u_last_name")].filter(Boolean).join(" ");
  if (explicit) return explicit;
  const sd = disp(r, "short_description");
  return nameFromTitle(sd) ?? nameFromNotes(v(r, "description")) ?? sd;
}

function offboardPayload(r: SnIncidentRecord): Record<string, unknown> {
  const name = offboardName(r);
  const tokens = name.split(/\s+/).filter(Boolean);
  const firstName = v(r, "u_first_name") || tokens[0] || "";
  const lastName = v(r, "u_last_name") || (tokens.length > 1 ? tokens.slice(1).join(" ") : "");
  // The executors resolve the EXISTING user by UPN/email. Use one from the incident when present;
  // otherwise planning derives a best-guess UPN from the name + the client's username pattern, and
  // the operator confirms the target on the (auto-paused) case before resuming.
  const email = firstVar(r, ["u_user_principal_name", "u_upn", "u_email", "u_user_email", "u_username"]);
  return {
    userToOffboard: name || null,
    displayName: name || null,
    firstName: orNull(firstName),
    lastName: orNull(lastName),
    UserPrincipalName: orNull(email),
    email: orNull(email),
    department: orNull(vd(r, "u_department")),
    // Canonical field name (matches intake-mapper + what repository/labels/toolbar read) so the
    // offboarding date renders on the case and the "scheduled" hold has a date to resume on.
    //
    // Deliberately NO `offboardAt` here, so an incident-sourced offboard is never AUTO-scheduled.
    // On a UM case, u_end_date is a glide_date_time whose `.value` ServiceNow guarantees to be UTC —
    // that guarantee is what makes firing off it safe. These are record-producer VARIABLES: free-form
    // strings captured in whatever format/timezone the requester's form used, with no such guarantee.
    // Reading one as UTC could be hours out, and being hours out means cutting someone's access while
    // they're still working. Incident offboards therefore stay held for a human, who can schedule the
    // case by hand on the case page.
    dateOfOffboarding: orNull(firstVar(r, ["u_last_day", "u_end_date", "u_termination_date"])),
    managerName: orNull(firstVar(r, ["u_manager"], true)),
    computerName: orNull(firstVar(r, ["u_computer_name", "u_computer"])),
    requestedBy: orNull(disp(r, "opened_by")),
    description: orNull(v(r, "description")),
  };
}

export function normalizeIncidentIntake(r: SnIncidentRecord): NormalizedIntake {
  const action = incidentAction(r) ?? "onboard";
  return {
    action,
    clientSysId: orNull(raw(r, "company")),
    caseNumber: raw(r, "number") || "",
    subject: disp(r, "short_description") || raw(r, "number") || (action === "offboard" ? "Internal offboarding" : "Internal onboarding"),
    payload: action === "offboard" ? offboardPayload(r) : onboardPayload(r),
  };
}
