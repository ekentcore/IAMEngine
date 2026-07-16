// Copy text to the clipboard, and say truthfully whether it worked.
//
// `navigator.clipboard` only exists in a SECURE CONTEXT: https://, or http:// on localhost. This app
// is served over plain HTTP on a LAN address (`next dev -H 0.0.0.0 -p 3000`), so on the host machine
// — reached as localhost — the API is there and copy works, while for everyone ELSE on the LAN
// `navigator.clipboard` is `undefined` and nothing can be written at all. That is why copy "worked on
// my machine" indefinitely while operators had to select the text by hand.
//
// Worse than not working: almost every call site was written `navigator.clipboard?.writeText(text)`
// and then set "Copied ✓" on the next line. The `?.` turns a missing API into a silent no-op — no
// throw, nothing to catch — so the button reported success over an empty clipboard. Three of those
// sites copy a ONE-TIME-SHOWN password, where believing the copy is what loses the password: the
// operator dismisses the dialog and it is unrecoverable by design.
//
// So: a real fallback for insecure origins, and a BOOLEAN return that the UI must honour. Never
// report success you haven't verified.
export async function copyText(text: string): Promise<boolean> {
  // The modern path. Present only in a secure context, and can still reject (permissions policy, or
  // Safari deciding the write drifted too far from the user gesture) — so a resolved promise, not the
  // API's mere existence, is the success signal.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through — execCommand still works in some cases the async API refuses
    }
  }
  return legacyCopy(text);
}

// document.execCommand("copy") — deprecated, and the only thing that works on an insecure origin.
// It copies the current SELECTION, so the text has to be put in a real, focusable, selectable node
// first. The details below are all load-bearing:
//   - `readOnly` + `contentEditable` dance: iOS Safari ignores select() on a readOnly input, but a
//     writable one pops the keyboard.
//   - position/opacity rather than `display:none` or `hidden`: an unrendered node has no selection,
//     so the copy silently does nothing.
//   - restore the previous selection + focus: this runs under the user's cursor, and eating their
//     selection to copy something else is its own bug.
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.padding = "0";
  ta.style.border = "none";
  ta.style.outline = "none";
  ta.style.boxShadow = "none";
  ta.style.background = "transparent";
  ta.style.opacity = "0";
  const previous = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const restore = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS needs the explicit range
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
    if (restore && selection) {
      selection.removeAllRanges();
      selection.addRange(restore);
    }
    previous?.focus?.();
  }
  return ok;
}

// Why a copy failed, for a UI that has to tell the operator something useful. Only ever called after
// a real failure — an insecure origin is the overwhelmingly likely cause here, but never the claim
// when the page is already secure.
export function copyFailureHint(): string {
  const insecure =
    typeof window !== "undefined" &&
    typeof window.isSecureContext === "boolean" &&
    !window.isSecureContext;
  return insecure
    ? "Copy is blocked because this page is served over plain HTTP — select the text and copy it by hand, or open the app over HTTPS."
    : "The browser blocked the clipboard — select the text and copy it by hand.";
}
