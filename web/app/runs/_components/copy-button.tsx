"use client";

// Kept as a named re-export so the run-log's call sites read the same as before. The implementation
// moved to @/app/_components/copy-button, which is the ONE copy button now: this file's version
// awaited navigator.clipboard.writeText and swallowed the failure, so on a plain-HTTP LAN origin —
// where the API doesn't exist at all — the button just did nothing, with no way for the operator to
// know why. See lib/clipboard.ts.
export { CopyButton } from "@/app/_components/copy-button";
