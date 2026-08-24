import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "adsynced-adopt-synced-account",
  date: "2026-08-24",
  time: "10:00",
  title: "AD-synced onboards adopt the account that synced up, instead of failing on it",
  items: [
    "An AD-synced onboard could fail with \"all candidate usernames are taken by other users\" while pointing at an account with the SAME NAME as the hire — the very account it was supposed to adopt. Apollon hit this on 5 of its last 8 onboards. (FR #0000105)",
    "Cause: we tell our own accounts apart by a marker we stamp on extensionAttribute1. On a directory-synced account that attribute is mastered ON-PREM — Entra Connect copies whatever the client's AD holds, and Graph cannot write it back — so a client that uses extensionAttribute1 for its own purposes made every synced account look like it belonged to somebody else. The name was never even compared",
    "A synced account's extensionAttribute1 is no longer read as a provisioning marker; the name decides. Cloud-only accounts are unchanged, where a foreign marker still means a different person — two same-named people are never cross-assigned, and a test pins that",
    "The earlier report that these clients were CREATING duplicate cloud accounts turned out to be wrong: adopt-only has been working since it shipped, and nothing was created. What looked like a create attempt was this hard failure",
    "When every candidate username is taken, the case now offers Adopt / Different person instead of dead-ending. The account on the primary username is often the right person under a slightly different display name — a middle initial, a maiden name, \"Last, First\" from a directory import. (FR #0000092)",
    "Once you have answered \"different person\" the plain error comes back, because at that point adding a fallback username pattern really is the fix",
    "Runner 1.109.0 (M365 module) needs deploy",
  ],
};
