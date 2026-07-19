import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "extra-access-indicator",
  date: "2026-07-19",
  time: "17:00",
  title: "Credential test: \"Extra Access\" shows over-permissioned roles distinctly",
  items: [
    "The rights breakdown on a credential's connection test already reported over-permissioned app roles — authority the credential holds that the engine never needs — but rendered every one of them with the exact same amber \"○ (optional)\" mark used for a genuinely MISSING optional permission. That reads backwards: \"too much access\" looked identical to \"not enough access\"",
    "Over-permissioned roles now render as their own \"Extra Access\" chip, distinct from missing/optional, and the rights badge shows \"Extra Access: N\" instead of \"N not needed\"",
    "A credential can be under- and over-permissioned at the same time — both now show together instead of one hiding the other",
    "Roles that are a genuine escalation risk (e.g. the credential could make itself Global Administrator) are called out more strongly, with the why shown inline; a merely-unused grant stays muted",
    "Still fully non-blocking: Extra Access never fails a test or turns the badge red, exactly as before",
    "Web-only change — works immediately on existing connection-test data by parsing the runner's existing 'OVER-PERMISSIONED:' / 'not needed:' row prefixes; no runner deploy required",
  ],
};
