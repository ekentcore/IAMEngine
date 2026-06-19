"use client";

import { useState } from "react";

// Copy a run-log line's full text (module + message + error) to the clipboard — so an operator can
// paste the exact failure into a ticket/chat without retyping it.
export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy this line's message + error"
      style={{ fontSize: 11, padding: "1px 7px" }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch { /* clipboard blocked — ignore */ }
      }}
    >
      {done ? "copied ✓" : "⧉ copy"}
    </button>
  );
}
