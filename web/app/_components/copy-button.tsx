"use client";

import { useState } from "react";
import { copyText, copyFailureHint } from "@/lib/clipboard";

// The one copy button. There were twelve, and most of them lied.
//
// The old shape was `navigator.clipboard?.writeText(text); setCopied(true);` — the `?.` makes a
// missing clipboard API a silent no-op, so the button reported "copied ✓" over an empty clipboard for
// every client that isn't the host (see lib/clipboard.ts: the API needs a secure context, and the app
// is served over plain HTTP on the LAN). Operators were told it worked and had to select the text by
// hand anyway.
//
// So the state here follows the RETURNED boolean, and a failure says so rather than pretending.
export function CopyButton({
  text,
  label = "⧉ copy",
  copiedLabel = "copied ✓",
  title = "Copy to the clipboard",
  style,
}: {
  text: string;
  label?: React.ReactNode;      // some callers vary it ("Copy macOS command" / "Copy Windows command")
  copiedLabel?: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <>
      <button
        type="button"
        title={state === "fail" ? copyFailureHint() : title}
        style={{ fontSize: 11, padding: "1px 7px", ...style }}
        onClick={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const ok = await copyText(text);
          setState(ok ? "ok" : "fail");
          // Leave a failure on screen long enough to read and act on; a success can blink away.
          setTimeout(() => setState("idle"), ok ? 1500 : 6000);
        }}
      >
        {state === "ok" ? copiedLabel : state === "fail" ? "copy blocked" : label}
      </button>
      {state === "fail" && (
        <span className="note" role="alert" style={{ color: "#b3261e", marginLeft: 6, fontSize: 11 }}>
          {copyFailureHint()}
        </span>
      )}
    </>
  );
}
