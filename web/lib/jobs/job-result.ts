// A runner job result is ONE envelope object ({ System, Status, Actions, … }). But a PowerShell
// function returns its entire pipeline, so a single stray un-captured emission inside an executor
// turns the posted result into an array — [null, {…the real envelope…}] — and every reader doing
// `result.Actions` silently sees nothing. That is how UM0029906 went wrong: the exchange step read
// the size (0.03 GB) and converted the mailbox, but its result arrived as an array, so the claim-time
// hand-off found no MailboxSizeGB and no "converted…" action line, and the entra step asked the
// operator to decide a question that was already answered — with "size unknown" hiding the convert
// button on a 33 MB mailbox.
//
// Collapse the shape in one place: an array's LAST non-null object element is the envelope — the
// envelope is the function's final output, so anything before it is the leak. Non-array results pass
// through untouched. Callers keep their own `?? {}` / typeof guards; this only unwraps the array.
export function jobResultEnvelope(result: unknown): unknown {
  if (!Array.isArray(result)) return result;
  for (let i = result.length - 1; i >= 0; i--) {
    const el = result[i];
    if (el !== null && typeof el === "object" && !Array.isArray(el)) return el;
  }
  return null;
}
