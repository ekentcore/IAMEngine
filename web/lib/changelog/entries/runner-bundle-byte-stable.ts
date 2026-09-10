import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "runner-bundle-byte-stable",
  date: "2026-09-10",
  time: "12:00",
  title: "Runners stop being told to update when nothing about the runner changed",
  items: [
    "\"Is this agent up to date?\" is answered by hashing the runner files the app serves and comparing that to the same hash computed by the agent over its own copy. The app hashed the files as they sit on disk — and on a Windows checkout git stores them with Unix line endings but writes them out with Windows ones",
    "So the hash was a property of whoever last checked the repo out, not of the code. Any tool that wrote a file with Unix endings changed it without changing a line of code, and the next git checkout changed it back. Both directions marked the ENTIRE fleet out of date",
    "That is not a cosmetic mislabel. An agent marked out of date is told to self-update, and a self-update exits the runner process and trusts the host's service manager to start it again",
    "This happened today: the id moved from 87edeaa68b62 to a70b00afa216 across a web-only merge that touched no runner file at all, marking all 20 runners stale. It is now back to 87edeaa68b62 — the build the healthy agents were already on — so they are correctly up to date and will not be restarted for nothing",
    "The bundle is now pinned to one line-ending style, so the id is reproducible from the commit alone: the same on a developer's box, in CI, and on a Linux host. Nothing in the bundle cares — PowerShell, Node and JSON all read it natively",
    "Two tests hold the line: no bundle file may contain a carriage return, and every bundle file on disk must be byte-identical to what is committed",
    "This is the other half of yesterday's change that stopped the app retrying a failing self-update forever. That one made a runaway loop survivable; this removes the most common thing that started one",
    "Web-only — no runner change, and no agent action needed",
  ],
};
